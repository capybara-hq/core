import { SandboxScopeDeniedError } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { EventLog } from "../conversations/event-log.js";
import {
  type ConversationEvent,
  type ManagedDevicePathsV1,
  ManagedDevicePathsV1Schema,
} from "../conversations/events.js";
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
import {
  type DevicePathsPayload,
  devicePathsChangeFromPayload,
  sameRoots,
} from "../runtime/context/device-paths.js";
import {
  type PermissionContextFailureKind,
  PublicationStale,
  permissionContextFailureKind,
} from "../runtime/permission-context-errors.js";
import { currentExecutionClaim, ExecutionRevoked } from "../runtime/run-execution.js";
import { SandboxOperationAuthority } from "./operation-authority.js";
import { PermissionAuthorityLock } from "./permission-authority-lock.js";
import { PermissionConfigPublication } from "./permission-config-publication.js";
import {
  type HeldDeviceContextEvidence,
  type PermissionContextSubject,
  PermissionContextSubjectChanged,
} from "./permission-context-types.js";
import { PermissionFacts } from "./permission-facts.js";

/** The tool error text of a managed operation whose held device context went stale (spec B3). */
export const MANAGED_DEVICE_CONTEXT_STALE_TEXT =
  "Device context changed before this operation. Retry the tool call.";
/** The tool error text of a managed operation whose device context could not be recorded. */
export const MANAGED_DEVICE_CONTEXT_FAILED_TEXT =
  "Device context could not be recorded, so the operation did not start. Retry the tool call.";

/**
 * The managed operation's held evidence (its device, provider, instance incarnation, installed
 * binding, roots or working root) is not the conversation's current one under the authority locks.
 * Thrown before any preparation or user callback; nothing was recorded and nothing ran.
 */
export class ManagedDeviceContextStale extends Error {
  override readonly name = "ManagedDeviceContextStale";
  constructor() {
    super(MANAGED_DEVICE_CONTEXT_STALE_TEXT);
  }
}

/**
 * The device context could not be recorded (stale publication, storage, an invalid recorded
 * payload, an unauthorized actor, a missing claim). Thrown before any preparation or user callback.
 */
export class ManagedDeviceContextFailed extends Error {
  override readonly name = "ManagedDeviceContextFailed";
  constructor(readonly kind: PermissionContextFailureKind | "refused") {
    super(MANAGED_DEVICE_CONTEXT_FAILED_TEXT);
  }
}

/** A writer reached a conversation or claim it must never write. */
class ManagedWriterRefused extends Error {
  override readonly name = "ManagedWriterRefused";
}

/** The managed dependency `common.ts` requires on an activated managed route (spec B3). */
export type ManagedDeviceContextPort = Pick<ManagedDeviceContextRecorder, "record">;

type Subject = { orgId: string; deviceId: string; rootConversationId: string };

/**
 * The writer of a managed operation's model-facing device paths (permission context replay spec,
 * "Task 8 exact common.ts handoff"): after a managed tool entered its held instance and before any
 * preparation or user callback, it records the marked `device_paths` payload (device, roots, working
 * root) into the calling conversation's log, or nothing when the latest one already equals it.
 *
 * One record attempt discovers the root without locks, then opens exactly one transaction whose
 * fence prelude takes the complete authority subject (platform, org, device, root) before the
 * inherited run fence. Inside it: the publication is current, the claim, run and actor are this
 * call's, and the held evidence equals the device's current installed environment (provider,
 * instance id, generation, installed binding, roots; `PermissionFacts.readAppliedEnvironmentLocked`,
 * the reader the recorded permission context uses) and admission's working root. Any difference is
 * {@link ManagedDeviceContextStale}: no rediscovery, no provisioning, no whole-handler retry. The
 * bus hint follows the commit and is lossy. A lower event writer, not a permission context
 * publisher; dormant until the paired activation passes it to `common.ts`.
 */
@Injectable()
export class ManagedDeviceContextRecorder {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(EventLog) private readonly events: Pick<EventLog, "appendIn" | "notify">,
    @Inject(PermissionProfileStore)
    private readonly profiles: Pick<PermissionProfileStore, "readRoot">,
    @Inject(PermissionAuthorityLock)
    private readonly locks: Pick<PermissionAuthorityLock, "acquire">,
    @Inject(PermissionConfigPublication)
    private readonly publication: Pick<PermissionConfigPublication, "assertCurrent">,
    @Inject(PermissionFacts)
    private readonly facts: Pick<PermissionFacts, "readAppliedEnvironmentLocked">,
    @Inject(SandboxOperationAuthority)
    private readonly authority: Pick<SandboxOperationAuthority, "workingRootFor">,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<KernelLogger, "warn">,
  ) {}

  /**
   * Records the managed device paths of `held` into the calling conversation's log, or nothing
   * when unchanged. Requires the run's real execution claim (`RunExecution.withClaim`) and no open
   * transaction. A revoked execution keeps its identical `ExecutionRevoked`, an abort its reason.
   */
  async record(
    input: PermissionContextSubject,
    held: Readonly<HeldDeviceContextEvidence>,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      signal.throwIfAborted();
      const claim = currentExecutionClaim();
      if (
        !claim ||
        claim.orgId !== input.orgId ||
        claim.runId !== input.runId ||
        claim.conversationId !== input.conversationId
      )
        throw new ManagedWriterRefused("Managed device context requires this run's claim");
      if (this.txHost.current())
        throw new ManagedWriterRefused("Managed device context is recorded outside a transaction");
      const subject = await this.discover(input, held, claim.rootId);
      await withTransactionFencePrelude(
        () => this.locks.acquire(subject, { kind: "admit" }),
        () => this.appendLocked(input, subject, held, signal),
      );
    } catch (error) {
      throw this.mapped(error, input, signal);
    }
  }

  private mapped(error: unknown, input: PermissionContextSubject, signal: AbortSignal): unknown {
    if (error instanceof ExecutionRevoked) return error;
    if (signal.aborted && (error === signal.reason || (error as Error)?.name === "AbortError"))
      return error;
    if (
      error instanceof ManagedDeviceContextStale ||
      error instanceof PermissionContextSubjectChanged ||
      (error instanceof ApiError && ["device.not_found", "conflict"].includes(error.code))
    )
      return new ManagedDeviceContextStale();
    const kind =
      error instanceof ManagedWriterRefused ? "refused" : permissionContextFailureKind(error);
    this.log.warn("managed device context not recorded", {
      conversationId: input.conversationId,
      runId: input.runId,
      kind,
      cause: error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 500) : "",
    });
    return new ManagedDeviceContextFailed(kind);
  }

  /** The complete authority subject, read without locks; validated again under them. */
  private async discover(
    input: PermissionContextSubject,
    held: Readonly<HeldDeviceContextEvidence>,
    claimRootId: string,
  ): Promise<Subject> {
    const conv = await this.db
      .selectFrom("conversations")
      .select(["org_id", "kind", "eval_run_id"])
      .where("id", "=", input.conversationId)
      .executeTakeFirst();
    if (!conv || conv.org_id !== input.orgId)
      throw new ApiError("conversation.not_found", "Conversation not found");
    if (conv.kind === "eval" || conv.eval_run_id !== null)
      throw new ManagedWriterRefused("A replay conversation never records live device context");
    const root = await this.profiles.readRoot(input.orgId, input.conversationId);
    if (root.id !== claimRootId)
      throw new ManagedWriterRefused("The execution claim belongs to another conversation tree");
    if (root.device_id !== held.deviceId) throw new ManagedDeviceContextStale();
    return { orgId: input.orgId, deviceId: held.deviceId, rootConversationId: root.id };
  }

  /**
   * The one transaction of a record attempt: its fence already holds the complete authority
   * subject and the inherited run fence. Returns the appended seq, or null when unchanged.
   */
  @Transactional()
  private async appendLocked(
    input: PermissionContextSubject,
    subject: Subject,
    held: Readonly<HeldDeviceContextEvidence>,
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
      throw new ManagedWriterRefused("Managed device context requires this run's claim");
    // the run fence's order (org, root, calling conversation), then the explicit claim comparison
    const org = await this.db
      .selectFrom("orgs")
      .select("deleted_at")
      .where("id", "=", input.orgId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (!org || org.deleted_at !== null) throw new ExecutionRevoked();
    const rootRow = await this.db
      .selectFrom("conversations")
      .select(["deleted_at", "kind", "eval_run_id"])
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
    if (
      conv.kind === "eval" ||
      conv.eval_run_id !== null ||
      rootRow.kind === "eval" ||
      rootRow.eval_run_id !== null
    )
      throw new ManagedWriterRefused("A replay conversation never records live device context");
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
    // every comparison under the complete authority subject, before the latest event is read
    const root = await this.profiles.readRoot(input.orgId, input.conversationId);
    if (root.id !== subject.rootConversationId || root.device_id !== held.deviceId)
      throw new ManagedDeviceContextStale();
    const applied = await this.facts.readAppliedEnvironmentLocked({
      orgId: input.orgId,
      deviceId: held.deviceId,
    });
    // identical paths cannot satisfy a replaced binding or generation
    if (
      applied === null ||
      applied.provider !== held.provider ||
      applied.instanceId !== held.instanceId ||
      applied.instanceGeneration !== held.instanceGeneration ||
      applied.bindingId !== held.bindingId ||
      !sameRoots(applied.roots, held.roots)
    )
      throw new ManagedDeviceContextStale();
    const workingRoot = await this.authority.workingRootFor({
      orgId: input.orgId,
      deviceId: held.deviceId,
      conversationId: input.conversationId,
    });
    if (workingRoot !== held.workingRoot) throw new ManagedDeviceContextStale();
    const payload: ManagedDevicePathsV1 = ManagedDevicePathsV1Schema.parse({
      permissionContextVersion: 1,
      deviceId: held.deviceId,
      roots: { workspace: held.roots.workspace, skills: held.roots.skills, tmp: held.roots.tmp },
      workingRoot: held.workingRoot,
    });
    // the persisted log decides (old to marked appends even for identical roots; A to B to A too)
    const latest = await this.db
      .selectFrom("conversation_events")
      .select(["seq", "payload"])
      .where("conversation_id", "=", input.conversationId)
      .where("type", "=", "device_paths")
      .orderBy("seq", "desc")
      .limit(1)
      .executeTakeFirst();
    const change = devicePathsChangeFromPayload(
      latest
        ? { seq: Number(latest.seq), payload: latest.payload as DevicePathsPayload }
        : undefined,
      payload,
      input.runId,
    );
    if (change === null) return null;
    signal.throwIfAborted();
    const [event]: ConversationEvent[] = await this.events.appendIn(input.conversationId, [change]);
    if (!event) throw new Error("The managed device paths append returned no event");
    const conversationId = input.conversationId;
    // a lossy hint after the commit; a rollback drops it, a failure never replays anything
    afterCommit(() => this.events.notify(conversationId, event.seq));
    return event.seq;
  }
}
