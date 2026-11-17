import { SandboxScopeDeniedError } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { EventLog } from "../conversations/event-log.js";
import { PermissionContextV1Schema } from "../conversations/events.js";
import { PermissionProfileStore } from "../conversations/permission-profile-store.js";
import { ApiError } from "../errors.js";
import { afterCommit } from "../infra/database/after-commit.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import {
  TransactionHost,
  withTransactionFencePrelude,
} from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { SandboxOperationAuthority } from "../sandbox/operation-authority.js";
import type { AuthoritySubject } from "../sandbox/permission-authority-lock.js";
import { PermissionAuthorityLock } from "../sandbox/permission-authority-lock.js";
import { PermissionConfigPublication } from "../sandbox/permission-config-publication.js";
import {
  type PermissionContextSubject,
  PermissionContextSubjectChanged,
} from "../sandbox/permission-context-types.js";
import {
  permissionContextHash,
  permissionContextIdemKey,
  RecordedPermissionContextError,
} from "./context/permission-profile.js";
import { RunError } from "./model-call.js";
import { currentExecutionClaim, type ExecutionClaim, ExecutionRevoked } from "./run-execution.js";

/** The named no-send failures of a permission context read or append (spec B2 table). */
export const PERMISSION_CONTEXT_RUN_ERRORS = {
  stale: {
    code: "run.permission_context_stale",
    message:
      "Permission configuration changed. Wait for configuration activation, then retry this run.",
  },
  changed: {
    code: "run.permission_context_changed",
    message:
      "The device binding changed while preparing this request. Retry the run after the binding settles.",
  },
  unavailable: {
    code: "run.permission_context_unavailable",
    message:
      "Permission context could not be read or recorded. Retry this run when storage is available.",
  },
  invalid: {
    code: "run.permission_context_invalid",
    message:
      "Permission context is invalid. Ask an administrator to inspect the run before retrying.",
  },
  actor: {
    code: "run.permission_context_actor_unavailable",
    message:
      "This run's actor is no longer authorized. Start a new run with an authorized account.",
  },
} as const;
type PermissionContextFailure = keyof typeof PERMISSION_CONTEXT_RUN_ERRORS;
const runError = (kind: PermissionContextFailure) =>
  new RunError(
    PERMISSION_CONTEXT_RUN_ERRORS[kind].code,
    PERMISSION_CONTEXT_RUN_ERRORS[kind].message,
  );

/** The replica has not applied the current permission configuration (checked under the locks). */
class PublicationStale extends Error {
  override readonly name = "PublicationStale";
}
/** A live recorder reached a conversation it must never write (an eval replay, a wrong claim). */
class RecorderRefused extends Error {
  override readonly name = "RecorderRefused";
}

/** SQLSTATE classes of a database that is unreachable, overloaded or aborting, not of bad data. */
const STORAGE_SQLSTATE = /^(08|40|53|57|58|XX)[0-9A-Z]{3}$/;
const STORAGE_NODE = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENOTFOUND"]);
function isStorageError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && (STORAGE_SQLSTATE.test(code) || STORAGE_NODE.has(code)))
    return true;
  return /Connection terminated|timeout exceeded when trying to connect/i.test(error.message);
}

/**
 * Maps a failure of a permission context read or append (and of the complete-log refresh after it)
 * to what the run sees, before any request is sent: a revoked or replaced execution keeps its
 * identical `ExecutionRevoked` object, an abort keeps its reason, a `RunError` passes, and every
 * other failure becomes one of the named run errors. A recorded `permission_context` (or marked
 * path) the strict v1 schema rejects is `run.permission_context_invalid`, never a provider error
 * and never rendered as historical text.
 */
export function permissionContextFailure(error: unknown, signal?: AbortSignal): unknown {
  if (error instanceof ExecutionRevoked || error instanceof RunError) return error;
  if (signal?.aborted && (error === signal.reason || (error as Error)?.name === "AbortError"))
    return error;
  if (error instanceof PublicationStale || error instanceof SandboxScopeDeniedError)
    return runError("stale");
  if (error instanceof PermissionContextSubjectChanged) return runError("changed");
  if (
    error instanceof ApiError &&
    ["conversation.not_found", "forbidden", "org.not_found"].includes(error.code)
  )
    return runError("actor");
  if (isStorageError(error)) return runError("unavailable");
  if (error instanceof RecordedPermissionContextError) return runError("invalid");
  return runError("invalid");
}

/**
 * The live recorder of the model-facing permission context (spec "Live facts and writer
 * contract"). For one request construction it discovers the conversation's root and device
 * without locks, then opens exactly one transaction whose fence prelude takes the complete
 * authority subject (platform, org, device when selected, root) before the inherited run fence
 * (org, root, calling conversation, execution id). Inside it re-validates the claim, the run and
 * the discovered subject, reads the authority projection shared with admission, compares it with
 * the latest recorded `permission_context` of the calling conversation and appends a new snapshot
 * only when the payload differs (A to B to A appends three). One changed subject is rediscovered
 * outside the transaction; a second fails the run. An abort, a replaced claim or a deleted
 * conversation appends nothing. The bus hint follows the commit.
 *
 * Dormant: nothing in production calls it until the request boundary and the managed tool path
 * activate together (Gate 9.4 with Task 8 phase 8.6).
 */
@Injectable()
export class PermissionContextRecorder {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(EventLog) private readonly events: Pick<EventLog, "appendIn" | "notify">,
    @Inject(SandboxOperationAuthority)
    private readonly authority: Pick<SandboxOperationAuthority, "readContextLocked">,
    @Inject(PermissionAuthorityLock)
    private readonly locks: Pick<PermissionAuthorityLock, "acquire">,
    @Inject(PermissionConfigPublication)
    private readonly publication: Pick<PermissionConfigPublication, "assertCurrent">,
    @Inject(PermissionProfileStore)
    private readonly profiles: Pick<PermissionProfileStore, "readRoot">,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<KernelLogger, "warn">,
  ) {}

  /**
   * Records the current permission context into the calling conversation's log, or nothing when
   * the latest recorded snapshot already equals it. Requires the real execution claim of this run
   * (`RunExecution.withClaim`) and no open transaction.
   */
  async record(input: PermissionContextSubject, signal: AbortSignal): Promise<void> {
    try {
      const claim = currentExecutionClaim();
      if (
        !claim ||
        claim.orgId !== input.orgId ||
        claim.runId !== input.runId ||
        claim.conversationId !== input.conversationId
      )
        throw new RecorderRefused("A permission context requires this run's execution claim");
      if (this.txHost.current())
        throw new RecorderRefused("A permission context is recorded outside any transaction");
      for (let attempt = 0; ; attempt++) {
        signal.throwIfAborted();
        try {
          const subject = await this.discover(input, claim);
          await withTransactionFencePrelude(
            () => this.locks.acquire(subject, { kind: "admit" }),
            () => this.appendLocked(input, subject, signal),
          );
          return;
        } catch (error) {
          // one rediscovery outside the transaction; never a lock added under held ones
          if (attempt === 0 && changedSubject(error)) continue;
          throw error;
        }
      }
    } catch (error) {
      const mapped = permissionContextFailure(
        error instanceof ApiError && error.code === "device.not_found"
          ? new PermissionContextSubjectChanged()
          : error,
        signal,
      );
      if (
        mapped instanceof RunError &&
        (mapped.code === PERMISSION_CONTEXT_RUN_ERRORS.invalid.code ||
          mapped.code === PERMISSION_CONTEXT_RUN_ERRORS.unavailable.code)
      )
        this.log.warn("permission context not recorded", {
          conversationId: input.conversationId,
          runId: input.runId,
          code: mapped.code,
          cause: error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 500) : "",
        });
      throw mapped;
    }
  }

  /** The complete authority subject, read without locks; validated again under them. */
  private async discover(
    input: PermissionContextSubject,
    claim: Readonly<ExecutionClaim>,
  ): Promise<AuthoritySubject & { orgId: string; rootConversationId: string }> {
    const conv = await this.db
      .selectFrom("conversations")
      .select(["org_id", "kind", "eval_run_id"])
      .where("id", "=", input.conversationId)
      .executeTakeFirst();
    if (!conv || conv.org_id !== input.orgId)
      throw new ApiError("conversation.not_found", "Conversation not found");
    if (conv.kind === "eval" || conv.eval_run_id !== null)
      throw new RecorderRefused("A replay conversation never records live permission context");
    const root = await this.profiles.readRoot(input.orgId, input.conversationId);
    if (root.id !== claim.rootId)
      throw new RecorderRefused("The execution claim belongs to another conversation tree");
    return {
      orgId: input.orgId,
      rootConversationId: root.id,
      ...(root.device_id ? { deviceId: root.device_id } : {}),
    };
  }

  /**
   * The one transaction of a record attempt: its fence already holds the complete authority
   * subject and the inherited run fence. Returns the appended seq, or null when deduplicated.
   */
  @Transactional()
  private async appendLocked(
    input: PermissionContextSubject,
    subject: AuthoritySubject & { orgId: string; rootConversationId: string },
    signal: AbortSignal,
  ): Promise<number | null> {
    signal.throwIfAborted();
    try {
      await this.publication.assertCurrent();
    } catch (error) {
      if (error instanceof SandboxScopeDeniedError) throw new PublicationStale(error.message);
      throw error;
    }
    const claim = currentExecutionClaim();
    if (!claim || claim.runId !== input.runId || claim.conversationId !== input.conversationId)
      throw new RecorderRefused("A permission context requires this run's execution claim");
    // The same order as the run fence (org, root, calling conversation), then the explicit claim
    // comparison: without the inherited wrapper this transaction still cannot write unfenced.
    const org = await this.db
      .selectFrom("orgs")
      .select("deleted_at")
      .where("id", "=", input.orgId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (!org || org.deleted_at !== null) throw new ExecutionRevoked();
    const rootRow = await this.db
      .selectFrom("conversations")
      .select("deleted_at")
      .where("id", "=", subject.rootConversationId)
      .where("org_id", "=", input.orgId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    const conv = await this.db
      .selectFrom("conversations")
      .select(["deleted_at", "kind", "eval_run_id"])
      .where("id", "=", input.conversationId)
      .where("org_id", "=", input.orgId)
      .forUpdate()
      .executeTakeFirst();
    if (!rootRow || rootRow.deleted_at !== null || !conv || conv.deleted_at !== null)
      throw new ExecutionRevoked();
    if (conv.kind === "eval" || conv.eval_run_id !== null)
      throw new RecorderRefused("A replay conversation never records live permission context");
    const run = await this.db
      .selectFrom("runs")
      .select(["conversation_id", "status", "execution_id", "trigger_account_id"])
      .where("id", "=", input.runId)
      .executeTakeFirst();
    if (
      !run ||
      run.conversation_id !== input.conversationId ||
      run.status !== "running" ||
      run.execution_id !== claim.executionId
    )
      throw new ExecutionRevoked();
    if (run.trigger_account_id !== input.accountId)
      throw new ApiError("forbidden", "This run's actor is no longer authorized");
    const root = await this.profiles.readRoot(input.orgId, input.conversationId);
    if (
      root.id !== subject.rootConversationId ||
      (root.device_id ?? undefined) !== subject.deviceId
    )
      throw new PermissionContextSubjectChanged();
    const payload = await this.authority.readContextLocked(input, signal);
    if (payload.rootConversationId !== subject.rootConversationId)
      throw new PermissionContextSubjectChanged();
    // the persisted log decides: the latest snapshot of this conversation, under its row lock
    const latest = await this.db
      .selectFrom("conversation_events")
      .select(["seq", "payload"])
      .where("conversation_id", "=", input.conversationId)
      .where("type", "=", "permission_context")
      .orderBy("seq", "desc")
      .limit(1)
      .executeTakeFirst();
    const previousSeq = latest ? Number(latest.seq) : 0;
    if (latest) {
      const prior = PermissionContextV1Schema.safeParse(latest.payload);
      if (!prior.success)
        throw new RecordedPermissionContextError(previousSeq, "permission_context");
      if (permissionContextHash(prior.data) === permissionContextHash(payload)) return null;
    }
    signal.throwIfAborted();
    const [event] = await this.events.appendIn(input.conversationId, [
      {
        type: "permission_context",
        runId: input.runId,
        idemKey: permissionContextIdemKey(payload, previousSeq),
        payload,
      },
    ]);
    if (!event) throw new Error("The permission context append returned no event");
    const conversationId = input.conversationId;
    // a lossy hint after the commit; a rollback drops it
    afterCommit(() => this.events.notify(conversationId, event.seq));
    return event.seq;
  }
}

function changedSubject(error: unknown): boolean {
  return (
    error instanceof PermissionContextSubjectChanged ||
    (error instanceof ApiError && error.code === "device.not_found")
  );
}
