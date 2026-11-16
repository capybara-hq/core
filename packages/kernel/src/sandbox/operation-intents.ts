import { createHash, randomUUID } from "node:crypto";
import {
  parseSandboxExecutionRef,
  parseSandboxOperationScope,
  type SandboxExecutionRef,
  SandboxOperationOutcomeUnknownError,
  SandboxPermissionUnsupportedError,
  SandboxScopeDeniedError,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import type { Selectable } from "kysely";
import { sql } from "kysely";
import type { SandboxOperationIntentsTable } from "../db/kernel-schema.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { OutboxService } from "../infra/outbox/outbox.service.js";
import type { ExecutionClaim } from "../runtime/run-execution.js";
import type { SandboxAuthorityOperation } from "./operation-authority.js";
import { SandboxOperationAuthority } from "./operation-authority.js";
import {
  describeOperationPayload,
  OperationPayloads,
  payloadReference,
} from "./operation-payloads.js";
import { PermissionAuthorityEpochStore } from "./permission-authority-epochs.js";
import { type AuthoritySubject, PermissionAuthorityLock } from "./permission-authority-lock.js";
import { permissionScopeHash } from "./permission-facts.js";
import type { SandboxUseContext } from "./use-context.js";

export class PermissionAdmissionStale extends Error {}

export const OPERATION_RECONCILE = "sandbox-operation-reconcile";
export const OPERATION_REVOKE = "sandbox-operation-revoke";
export type OperationIntent = Selectable<SandboxOperationIntentsTable>;
/** Supplied only by the executing tool worker, never tool/model arguments. */
export interface OperationInvocation {
  claim: ExecutionClaim;
  callId: string;
  ordinal: number;
  deadlineMs: number;
}
export interface OperationInstance {
  provider: string;
  providerVersion: string;
  generation: string;
}
/**
 * The task fields a backgroundStart's dispatch binds: the reservation persisted before dispatch
 * must match the exact start input, so the stable input hash covers the artifact and deadlines.
 */
export interface BackgroundDispatchBinding {
  taskId: string;
  workingRoot: string;
  outputPath: string;
  retainUntilMs: number;
  /** The held instance's handle id; the typed start result must name it. */
  instanceId: string;
}
/** What acknowledging a start did: live running authority, or an owed exact cancellation. */
export type BackgroundAcknowledgement = "acknowledged" | "cancel-pending";
/** Stop claims older than this are abandoned (mirrors the background store's claim TTL). */
const STOP_CLAIM_TTL_MS = 5 * 60_000;
const stopClaimed = sql<boolean>`(stopping_at IS NOT NULL AND stopping_at >= now() - ${STOP_CLAIM_TTL_MS}::integer * interval '1 millisecond')`;
export function operationIdFor(
  i: Pick<OperationInvocation, "callId" | "ordinal"> & { claim: Pick<ExecutionClaim, "runId"> },
): string {
  return createHash("sha256")
    .update(JSON.stringify([i.claim.runId, i.callId, i.ordinal]))
    .digest("hex");
}
export function operationResult(value: unknown): unknown {
  if (value && typeof value === "object" && "$expired" in value)
    throw new SandboxOperationOutcomeUnknownError(
      "The retained operation result has expired; this consumed identity cannot run again",
    );
  if (value && typeof value === "object" && "$failure" in value) {
    const f = (value as { $failure: { kind: string; message: string } }).$failure;
    if (f.kind === "denied") throw new SandboxScopeDeniedError(f.message);
    if (f.kind === "unsupported") throw new SandboxPermissionUnsupportedError(f.message);
  }
  return hydrateOperationBytes(value);
}
function hydrateOperationBytes(value: unknown): unknown {
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return value.map(hydrateOperationBytes);
  if (value && typeof value === "object") {
    if ("$bytes" in value && typeof value.$bytes === "string" && Object.keys(value).length === 1)
      return new Uint8Array(Buffer.from(value.$bytes, "base64"));
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [key, hydrateOperationBytes(v)]),
    );
  }
  return value;
}
const subjectOf = (r: OperationIntent): AuthoritySubject => ({
  orgId: r.org_id,
  deviceId: r.device_id,
  ...(r.root_conversation_id ? { rootConversationId: r.root_conversation_id } : {}),
});
const denied = (message: string): never => {
  throw new SandboxScopeDeniedError(message);
};

/** No provider effects occur in this service. Each public mutation owns its transaction. */
@Injectable()
export class SandboxOperationIntents {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(PermissionAuthorityLock) private readonly locks: PermissionAuthorityLock,
    @Inject(PermissionAuthorityEpochStore) private readonly epochs: PermissionAuthorityEpochStore,
    @Inject(SandboxOperationAuthority) private readonly authority: SandboxOperationAuthority,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(OperationPayloads) private readonly payloads: OperationPayloads,
  ) {}
  /** Current run claim plus its actual tool_call_started row authorize an internal invocation identity. */
  private async assertClaim(
    ctx: SandboxUseContext,
    invocation: OperationInvocation,
  ): Promise<void> {
    const c = invocation.claim;
    if (
      !Number.isSafeInteger(invocation.ordinal) ||
      invocation.ordinal < 0 ||
      c.orgId !== ctx.orgId ||
      c.conversationId !== ctx.holderConversationId ||
      c.runId !== ctx.actor.runId
    )
      denied("Operation invocation does not match its executing run");
    const run = await this.db
      .selectFrom("runs")
      .select(["execution_id", "trigger_account_id", "status"])
      .where("id", "=", c.runId)
      .where("conversation_id", "=", c.conversationId)
      .forShare()
      .executeTakeFirst();
    if (
      !run ||
      run.execution_id !== c.executionId ||
      run.trigger_account_id !== ctx.actor.accountId ||
      run.status !== "running"
    )
      denied("The tool execution claim is no longer current");
    const call = await this.db
      .selectFrom("conversation_events")
      .select("seq")
      .where("conversation_id", "=", c.conversationId)
      .where("run_id", "=", c.runId)
      .where("type", "=", "tool_call_started")
      .where(sql<string>`payload->>'callId'`, "=", invocation.callId)
      .executeTakeFirst();
    if (!call) denied("The operation has no recorded tool invocation");
  }
  @Transactional({ propagation: "requires_new" })
  async pending(
    ctx: SandboxUseContext,
    invocation: OperationInvocation,
    instance: OperationInstance,
    method: SandboxAuthorityOperation,
    input: unknown,
    holderTag: string,
    signal: AbortSignal,
  ): Promise<OperationIntent> {
    signal.throwIfAborted();
    const id = operationIdFor(invocation);
    const described = describeOperationPayload(input);
    const payload = payloadReference("input", described);
    const hash = permissionScopeHash({ method, inputDigest: described.digest });
    const previous = await this.db
      .selectFrom("sandbox_operation_intents")
      .selectAll()
      .where("operation_id", "=", id)
      .executeTakeFirst();
    if (previous) {
      this.assertIdentity(previous, ctx, instance, method, hash);
      if (
        previous.state === "pending" &&
        (previous.execution_id !== invocation.claim.executionId ||
          previous.deadline.getTime() <= Date.now())
      )
        denied("Pending operation claim changed or admission deadline elapsed");
      if (previous.state !== "pending") {
        await this.locks.acquire(subjectOf(previous), { kind: "admit" });
        await this.assertClaim(ctx, invocation);
        return previous;
      }
    }
    // resolve joins this transaction and holds every shared ancestor through the insert commit.
    const {
      scope: resolved,
      permissionGrantId,
      grantedHosts,
      executionGrants,
    } = await this.authority.resolveInvocation(
      ctx,
      method,
      { runId: invocation.claim.runId, callId: invocation.callId },
      signal,
    );
    await this.assertClaim(ctx, invocation);
    if (resolved.rootConversationId !== invocation.claim.rootId)
      denied("The operation root no longer matches the execution claim");
    const deadline = Math.min(
      resolved.admitBeforeMs,
      invocation.deadlineMs,
      previous?.deadline.getTime() ?? Infinity,
    );
    if (!Number.isSafeInteger(deadline) || deadline <= Date.now())
      denied("Operation admission deadline elapsed");
    const scope = parseSandboxOperationScope({
      ...resolved,
      operationId: id,
      tag: id,
      admitBeforeMs: deadline,
    });
    const vector = await this.epochs.readLocked({
      orgId: ctx.orgId,
      deviceId: ctx.deviceId,
      rootConversationId: scope.rootConversationId,
    });
    await this.db
      .insertInto("sandbox_operation_intents")
      .values({
        operation_id: id,
        org_id: ctx.orgId,
        account_id: ctx.actor.accountId,
        device_id: ctx.deviceId,
        root_conversation_id: scope.rootConversationId,
        conversation_id: ctx.holderConversationId,
        run_id: invocation.claim.runId,
        call_id: invocation.callId,
        ordinal: invocation.ordinal,
        method,
        input_hash: hash,
        permission_grant_id: permissionGrantId,
        granted_hosts: JSON.stringify(grantedHosts),
        execution_grants: executionGrants === null ? null : JSON.stringify(executionGrants),
        admission_hash: permissionScopeHash({
          method,
          inputDigest: described.digest,
          scope,
          executionGrants,
        }),
        input: payload,
        scope: JSON.stringify(scope),
        epochs: JSON.stringify(vector),
        provider: instance.provider,
        provider_version: instance.providerVersion,
        instance_generation: instance.generation,
        deadline: new Date(deadline),
        retain_until: new Date(deadline + 86_400_000),
        execution_id: invocation.claim.executionId,
        holder_token: holderTag,
      })
      .onConflict((oc) => oc.column("operation_id").doNothing())
      .execute();
    if (previous?.state === "pending")
      await this.db
        .updateTable("sandbox_operation_intents")
        .set({
          input: payload,
          scope: JSON.stringify(scope),
          permission_grant_id: permissionGrantId,
          granted_hosts: JSON.stringify(grantedHosts),
          execution_grants: executionGrants === null ? null : JSON.stringify(executionGrants),
          admission_hash: permissionScopeHash({
            method,
            inputDigest: described.digest,
            scope,
            executionGrants,
          }),
          epochs: JSON.stringify(vector),
          deadline: new Date(deadline),
          retain_until: new Date(deadline + 86_400_000),
          updated_at: new Date(),
        })
        .where("operation_id", "=", id)
        .where("state", "=", "pending")
        .execute();
    const row = await this.read(id);
    this.assertIdentity(row, ctx, instance, method, hash);
    if (row.state === "pending") await this.payloads.save(id, "input", input, described);
    await this.scheduleExpiry(row);
    return row;
  }
  /** Owner-native reads have their own admission, without a manufactured conversation or run. */
  @Transactional({ propagation: "requires_new" })
  async admitBrowse(
    ctx: { orgId: string; deviceId: string; accountId: string },
    instance: OperationInstance,
    method: "stat" | "list" | "scan",
    input: unknown,
    signal: AbortSignal,
  ): Promise<OperationIntent> {
    const scope = await this.authority.resolveBrowse(ctx, signal);
    const described = describeOperationPayload(input);
    const payload = payloadReference("input", described);
    const vector = await this.epochs.readLocked({ orgId: ctx.orgId, deviceId: ctx.deviceId });
    const row = await this.db
      .insertInto("sandbox_operation_intents")
      .values({
        operation_id: scope.operationId,
        org_id: ctx.orgId,
        account_id: ctx.accountId,
        device_id: ctx.deviceId,
        root_conversation_id: null,
        conversation_id: null,
        run_id: null,
        call_id: null,
        ordinal: 0,
        method,
        input_hash: permissionScopeHash({ method, inputDigest: described.digest }),
        admission_hash: permissionScopeHash({ method, inputDigest: described.digest, scope }),
        input: payload,
        scope: JSON.stringify(scope),
        epochs: JSON.stringify(vector),
        provider: instance.provider,
        provider_version: instance.providerVersion,
        instance_generation: instance.generation,
        deadline: new Date(scope.admitBeforeMs),
        retain_until: new Date(scope.admitBeforeMs + 86_400_000),
        state: "admitted",
        execution_id: scope.operationId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await this.outbox.add({
      queue: "cap-kernel-maintenance",
      name: OPERATION_RECONCILE,
      jobId: `${OPERATION_RECONCILE}-${row.operation_id}`,
      data: { operationId: row.operation_id },
      orgId: ctx.orgId,
      runAt: row.deadline,
    });
    await this.payloads.save(row.operation_id, "input", input, described);
    await this.scheduleExpiry(row);
    return row;
  }
  @Transactional({ propagation: "requires_new" })
  async claimBrowse(
    ctx: { orgId: string; deviceId: string; accountId: string },
    id: string,
  ): Promise<OperationIntent> {
    await this.locks.acquire({ orgId: ctx.orgId, deviceId: ctx.deviceId }, { kind: "admit" });
    const row = await this.db
      .selectFrom("sandbox_operation_intents")
      .selectAll()
      .where("operation_id", "=", id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (
      row.org_id !== ctx.orgId ||
      row.device_id !== ctx.deviceId ||
      row.account_id !== ctx.accountId ||
      row.run_id !== null
    )
      denied("The browse admission does not match this owner");
    if (row.state !== "admitted" || row.deadline.getTime() <= Date.now())
      denied("Browse admission was revoked or expired");
    await this.authority.resolveBrowse(ctx, new AbortController().signal);
    await this.db
      .updateTable("sandbox_operation_intents")
      .set({ state: "dispatching", updated_at: new Date() })
      .where("operation_id", "=", id)
      .execute();
    return { ...row, state: "dispatching" };
  }
  private assertIdentity(
    r: OperationIntent,
    ctx: SandboxUseContext,
    instance: OperationInstance,
    method: SandboxAuthorityOperation,
    hash: string,
  ): void {
    if (
      r.org_id !== ctx.orgId ||
      r.account_id !== ctx.actor.accountId ||
      r.device_id !== ctx.deviceId ||
      r.conversation_id !== ctx.holderConversationId ||
      r.method !== method ||
      r.input_hash !== hash
    )
      denied("Stable operation identity was reused with different input");
    if (
      r.provider !== instance.provider ||
      r.provider_version !== instance.providerVersion ||
      r.instance_generation !== instance.generation
    )
      throw new SandboxOperationOutcomeUnknownError(
        "The recorded operation belongs to another instance; do not repeat it",
      );
  }
  async read(id: string): Promise<OperationIntent> {
    return this.db
      .selectFrom("sandbox_operation_intents")
      .selectAll()
      .where("operation_id", "=", id)
      .executeTakeFirstOrThrow();
  }
  @Transactional({ propagation: "requires_new" })
  async admit(ctx: SandboxUseContext, invocation: OperationInvocation): Promise<OperationIntent> {
    const id = operationIdFor(invocation),
      initial = await this.read(id);
    await this.locks.acquire(subjectOf(initial), { kind: "admit" });
    await this.assertClaim(ctx, invocation);
    const r = await this.db
      .selectFrom("sandbox_operation_intents")
      .selectAll()
      .where("operation_id", "=", id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (r.state === "revoked") {
      if (r.outcome_unknown)
        throw new SandboxOperationOutcomeUnknownError(
          "Operation authority was revoked after dispatch; its outcome remains unknown",
        );
      denied("Operation authority was revoked");
    }
    if (r.state !== "pending") return r;
    if (r.deadline.getTime() <= Date.now()) denied("Operation admission deadline elapsed");
    const current = await this.epochs.readLocked(subjectOf(r));
    if (permissionScopeHash(current) !== permissionScopeHash(r.epochs))
      throw new PermissionAdmissionStale(
        "Authority changed before admission; refresh this pending method only",
      );
    if (r.deadline.getTime() <= Date.now()) denied("Operation admission deadline elapsed");
    // Re-read live access/project/tool state, not only the profile epoch.
    const {
      scope: fresh,
      permissionGrantId,
      grantedHosts,
      executionGrants,
    } = await this.authority.resolveInvocation(
      ctx,
      r.method,
      { runId: invocation.claim.runId, callId: invocation.callId },
      new AbortController().signal,
    );
    if (
      permissionGrantId !== r.permission_grant_id ||
      permissionScopeHash(executionGrants) !== permissionScopeHash(r.execution_grants) ||
      permissionScopeHash(grantedHosts) !== permissionScopeHash(r.granted_hosts) ||
      permissionScopeHash(fresh.filesystem) !==
        permissionScopeHash(parseSandboxOperationScope(r.scope).filesystem) ||
      permissionScopeHash(fresh.network) !==
        permissionScopeHash(parseSandboxOperationScope(r.scope).network) ||
      fresh.ceilingRevision !== r.scope.ceilingRevision ||
      fresh.profileRevision !== parseSandboxOperationScope(r.scope).profileRevision
    )
      throw new PermissionAdmissionStale(
        "Authority changed before admission; refresh this pending method only",
      );
    await this.db
      .updateTable("sandbox_operation_intents")
      .set({ state: "admitted", updated_at: new Date() })
      .where("operation_id", "=", id)
      .execute();
    await this.outbox.add({
      queue: "cap-kernel-maintenance",
      name: OPERATION_RECONCILE,
      jobId: `${OPERATION_RECONCILE}-${id}`,
      data: { operationId: id },
      orgId: r.org_id,
      runAt: r.deadline,
    });
    return { ...r, state: "admitted" };
  }
  @Transactional({ propagation: "requires_new" })
  async claimDispatch(
    ctx: SandboxUseContext,
    invocation: OperationInvocation,
    holderTag: string,
    background?: BackgroundDispatchBinding,
  ): Promise<OperationIntent> {
    const id = operationIdFor(invocation),
      initial = await this.read(id);
    await this.locks.acquire(subjectOf(initial), { kind: "admit" });
    await this.assertClaim(ctx, invocation);
    const r = await this.db
      .selectFrom("sandbox_operation_intents")
      .selectAll()
      .where("operation_id", "=", id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (r.state === "completed" || r.state === "background-running") return r;
    if (r.state === "revoked") {
      if (r.outcome_unknown)
        throw new SandboxOperationOutcomeUnknownError(
          "Operation authority was revoked after dispatch; its outcome remains unknown",
        );
      denied("Operation authority was revoked");
    }
    // Reconciliation on another current execution may only ask the provider about the SAME ID.
    if (r.state !== "admitted")
      throw new SandboxOperationOutcomeUnknownError(
        "Operation already dispatched; reconcile its recorded identity before continuing",
      );
    if (r.deadline.getTime() <= Date.now()) denied("Operation admission deadline elapsed");
    if (r.method === "backgroundStart" || background) {
      if (r.method !== "backgroundStart" || !background)
        return denied("A background start needs its exact task reservation");
      if (!(await this.bindBackgroundDispatch(r, invocation, background))) {
        // Pre-effect: the reservation was stopped or settled first. Nothing was dispatched.
        await this.db
          .updateTable("sandbox_operation_intents")
          .set({ state: "revoked", outcome_unknown: false, updated_at: new Date() })
          .where("operation_id", "=", id)
          .execute();
        return { ...r, state: "revoked", outcome_unknown: false };
      }
    }
    await this.db
      .updateTable("sandbox_operation_intents")
      .set({
        state: "dispatching",
        execution_id: invocation.claim.executionId,
        holder_token: holderTag,
        updated_at: new Date(),
      })
      .where("operation_id", "=", id)
      .execute();
    return {
      ...r,
      state: "dispatching",
      execution_id: invocation.claim.executionId,
      holder_token: holderTag,
    };
  }
  /**
   * Binds a managed task's reservation to its admitted start in the dispatch transaction: the
   * operation, per-method input hash, run claim, task-owned tag, exact instance and generation,
   * starting profile/ceiling revisions, grant locator and network authority. Conditional on the
   * reservation still being `pending`, running and not claimed by a stop, and on the persisted
   * working root, artifact and retention matching the start input. False: nothing dispatches; a
   * stop's claim settles the reservation as `stopped`.
   */
  private async bindBackgroundDispatch(
    r: OperationIntent,
    invocation: OperationInvocation,
    b: BackgroundDispatchBinding,
  ): Promise<boolean> {
    const scope = parseSandboxOperationScope(r.scope);
    const bound = await this.db
      .updateTable("background_tasks")
      .set({
        launch_state: "dispatched",
        input_digest: r.input_hash,
        run_execution_id: invocation.claim.executionId,
        task_tag: scope.tag,
        instance_id: b.instanceId,
        instance_provider: r.provider,
        instance_provider_version: r.provider_version,
        instance_generation: r.instance_generation,
        profile_revision: scope.profileRevision,
        ceiling_revision: scope.ceilingRevision,
        permission_grant_id: r.permission_grant_id,
        network_authority: r.execution_grants === null ? null : JSON.stringify(r.execution_grants),
      })
      .where("id", "=", b.taskId)
      .where("operation_id", "=", r.operation_id)
      .where("org_id", "=", r.org_id)
      .where("device_id", "=", r.device_id)
      .where("run_id", "=", invocation.claim.runId)
      .where("call_id", "=", invocation.callId)
      .where("launch_state", "=", "pending")
      .where("status", "=", "running")
      .where("working_root", "=", b.workingRoot)
      .where("output_path", "=", b.outputPath)
      .where("retain_until", "=", new Date(b.retainUntilMs))
      .where(sql<boolean>`NOT ${stopClaimed}`)
      .executeTakeFirst();
    if (Number(bound.numUpdatedRows) > 0) return true;
    await this.db
      .updateTable("background_tasks")
      .set({
        status: "stopped",
        launch_state: "terminal",
        finished_at: new Date(),
        stopping_at: null,
      })
      .where("id", "=", b.taskId)
      .where("operation_id", "=", r.operation_id)
      .where("launch_state", "=", "pending")
      .where("status", "=", "running")
      .where(stopClaimed)
      .execute();
    return false;
  }
  /**
   * Records a typed start result. A current dispatch (the same execution claim, or a recovery
   * claim) moves the intent to `background-running` and the task to `acknowledged` together; the
   * intent stays live revocable authority and is never completed like a foreground call. When a
   * writer revoked the intent first, or a stop claimed the task, the ref is attached to the
   * already owed cancellation (`cancel-pending`) and the exact revoke is enqueued; the revoked
   * intent is never resurrected. The launching run need not still be running.
   */
  @Transactional({ propagation: "requires_new" })
  async acknowledgeBackground(
    id: string,
    executionId: string,
    result: SandboxExecutionRef,
    instanceId: string,
  ): Promise<BackgroundAcknowledgement> {
    const initial = await this.read(id);
    await this.locks.acquire(subjectOf(initial), { kind: "admit" });
    const r = await this.db
      .selectFrom("sandbox_operation_intents")
      .selectAll()
      .where("operation_id", "=", id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const ref = parseSandboxExecutionRef(result);
    if (
      r.method !== "backgroundStart" ||
      ref.operationId !== r.operation_id ||
      ref.instanceGeneration !== r.instance_generation ||
      ref.instanceId !== instanceId
    )
      throw new SandboxOperationOutcomeUnknownError(
        "The start result does not name this operation's exact instance; reconcile the same identity",
      );
    if (r.execution_ref && permissionScopeHash(r.execution_ref) !== permissionScopeHash(ref))
      throw new SandboxOperationOutcomeUnknownError(
        "The start result conflicts with the recorded execution; reconcile the same identity",
      );
    const task = await this.db
      .selectFrom("background_tasks")
      .selectAll()
      .where("operation_id", "=", id)
      .forUpdate()
      .executeTakeFirst();
    if (!task || task.instance_id !== instanceId)
      throw new SandboxOperationOutcomeUnknownError(
        "The start result has no matching task reservation; reconcile the same identity",
      );
    const refJson = JSON.stringify(ref);
    if (r.state === "background-running") {
      if (task.launch_state !== "acknowledged")
        throw new SandboxOperationOutcomeUnknownError("The task record diverged from its start");
      return "acknowledged";
    }
    const live =
      ["dispatching", "started-or-unknown"].includes(r.state) && r.execution_id === executionId;
    if (!live && r.state !== "revoked")
      throw new SandboxOperationOutcomeUnknownError(
        "The start is not held by this dispatch; reconcile the same identity",
      );
    const stopped =
      task.status !== "running" ||
      task.launch_state !== "dispatched" ||
      (task.stopping_at !== null && task.stopping_at.getTime() >= Date.now() - STOP_CLAIM_TTL_MS);
    if (live && !stopped) {
      await this.db
        .updateTable("sandbox_operation_intents")
        .set({
          state: "background-running",
          execution_ref: refJson,
          outcome_unknown: false,
          updated_at: new Date(),
        })
        .where("operation_id", "=", id)
        .execute();
      await this.db
        .updateTable("background_tasks")
        .set({
          launch_state: "acknowledged",
          execution_ref: refJson,
          sandbox_created_at: new Date(Number(r.instance_generation)),
        })
        .where("id", "=", task.id)
        .execute();
      return "acknowledged";
    }
    // Revoked by a writer, or stopped by a person or tool: the cancellation is owed for this ref.
    await this.db
      .updateTable("sandbox_operation_intents")
      .set({ state: "revoked", execution_ref: refJson, updated_at: new Date() })
      .where("operation_id", "=", id)
      .execute();
    await this.db
      .updateTable("background_tasks")
      .set({
        launch_state: "cancel-pending",
        execution_ref: refJson,
        sandbox_created_at: new Date(Number(r.instance_generation)),
        cancel_requested_at: new Date(),
      })
      .where("id", "=", task.id)
      .where("launch_state", "in", ["dispatched", "cancel-pending"])
      .execute();
    await this.outbox.add({
      queue: "cap-kernel-maintenance",
      name: OPERATION_REVOKE,
      jobId: `${OPERATION_REVOKE}-${id}-ack`,
      data: { operationId: id },
      orgId: r.org_id,
    });
    return "cancel-pending";
  }
  /**
   * A task-specific recovery claim for a dispatched start whose acknowledgement was lost: a new
   * durable execution identity (never a borrowed run or holder token) that may only ask the
   * provider about the same operation and input. Null when nothing is left to recover.
   */
  @Transactional({ propagation: "requires_new" })
  async claimBackgroundRecovery(id: string): Promise<OperationIntent | null> {
    const initial = await this.read(id);
    await this.locks.acquire(subjectOf(initial), { kind: "admit" });
    const executionId = `recovery-${randomUUID()}`;
    const row = await this.db
      .updateTable("sandbox_operation_intents")
      .set({
        state: "started-or-unknown",
        outcome_unknown: true,
        execution_id: executionId,
        updated_at: new Date(),
      })
      .where("operation_id", "=", id)
      .where("method", "=", "backgroundStart")
      .where("state", "in", ["dispatching", "started-or-unknown"])
      .where("retain_until", ">", new Date())
      .returningAll()
      .executeTakeFirst();
    return row ?? null;
  }
  /** The recorded input of an operation (for a same-identity retry only). */
  async input(row: OperationIntent): Promise<unknown> {
    return hydrateOperationBytes(await this.payloads.load(row.operation_id, "input", row.input));
  }
  /** A deferred recovery retry: a new deterministic persisted attempt. */
  @Transactional({ propagation: "requires_new" })
  async deferBackgroundRecovery(id: string): Promise<void> {
    const row = await this.db
      .updateTable("sandbox_operation_intents")
      .set((eb) => ({ reconcile_attempt: eb("reconcile_attempt", "+", 1), updated_at: new Date() }))
      .where("operation_id", "=", id)
      .where("method", "=", "backgroundStart")
      .where("state", "=", "started-or-unknown")
      .where("retain_until", ">", new Date())
      .returning(["org_id", "reconcile_attempt"])
      .executeTakeFirst();
    if (row)
      await this.outbox.add({
        queue: "cap-kernel-maintenance",
        name: OPERATION_RECONCILE,
        jobId: `${OPERATION_RECONCILE}-${id}-recover-${row.reconcile_attempt}`,
        data: { operationId: id },
        orgId: row.org_id,
        runAt: new Date(Date.now() + 30000),
      });
  }
  @Transactional({ propagation: "requires_new" })
  async complete(id: string, executionId: string, result: unknown): Promise<void> {
    const initial = await this.read(id);
    if (initial.run_id !== null) {
      const run = await this.db
        .selectFrom("runs")
        .select("id")
        .where("id", "=", initial.run_id)
        .where("execution_id", "=", executionId)
        .where("status", "=", "running")
        .forShare()
        .executeTakeFirst();
      if (!run) return;
    }
    const row = await this.db
      .selectFrom("sandbox_operation_intents")
      .selectAll()
      .where("operation_id", "=", id)
      .where("execution_id", "=", executionId)
      .where("state", "in", ["dispatching", "started-or-unknown"])
      .forUpdate()
      .executeTakeFirst();
    if (!row) return;
    const failure =
      result && typeof result === "object" && "$failure" in result
        ? (result as { $failure: { message: string } }).$failure
        : null;
    if (row.method === "backgroundStart") {
      // A start's success is acknowledged as live authority, never completed like foreground.
      if (!failure) throw new Error("A background start result must be acknowledged");
      await this.db
        .updateTable("background_tasks")
        .set({
          status: "failed",
          launch_state: "terminal",
          finished_at: new Date(),
          lost_reason: `launch refused: ${failure.message}`.slice(0, 1000),
          stopping_at: null,
        })
        .where("operation_id", "=", id)
        .where("launch_state", "=", "dispatched")
        .where("status", "=", "running")
        .execute();
    }
    const payload =
      row.retain_until.getTime() <= Date.now()
        ? JSON.stringify({ $expired: true })
        : await this.payloads.save(id, "result", result);
    await this.db
      .updateTable("sandbox_operation_intents")
      .set({ state: "completed", result: payload, outcome_unknown: false, updated_at: new Date() })
      .where("operation_id", "=", id)
      .execute();
  }
  async result(row: OperationIntent): Promise<unknown> {
    return operationResult(await this.payloads.load(row.operation_id, "result", row.result));
  }
  @Transactional({ propagation: "requires_new" })
  async unknown(id: string): Promise<void> {
    await this.db
      .updateTable("sandbox_operation_intents")
      .set({ state: "started-or-unknown", outcome_unknown: true, updated_at: new Date() })
      .where("operation_id", "=", id)
      .where("state", "=", "dispatching")
      .execute();
  }
  /** Recovery never borrows a holder token. Only a new live run claim can reconcile by ID. */
  @Transactional({ propagation: "requires_new" })
  async claimReconciliation(
    ctx: SandboxUseContext,
    invocation: OperationInvocation,
    instance: OperationInstance,
    method: SandboxAuthorityOperation,
    input: unknown,
    holderTag: string,
  ): Promise<OperationIntent> {
    const id = operationIdFor(invocation),
      initial = await this.read(id);
    await this.locks.acquire(subjectOf(initial), { kind: "admit" });
    await this.assertClaim(ctx, invocation);
    const r = await this.db
      .selectFrom("sandbox_operation_intents")
      .selectAll()
      .where("operation_id", "=", id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    this.assertIdentity(
      r,
      ctx,
      instance,
      method,
      permissionScopeHash({ method, inputDigest: describeOperationPayload(input).digest }),
    );
    if (r.state === "completed" || r.state === "background-running") return r;
    if (r.state === "revoked") {
      if (r.outcome_unknown)
        throw new SandboxOperationOutcomeUnknownError(
          "Operation authority was revoked after dispatch; its outcome remains unknown",
        );
      denied("Operation authority was revoked");
    }
    if (
      !["dispatching", "started-or-unknown"].includes(r.state) ||
      r.execution_id === invocation.claim.executionId
    )
      throw new SandboxOperationOutcomeUnknownError(
        "Reconciliation requires a newly claimed run execution",
      );
    await this.db
      .updateTable("sandbox_operation_intents")
      .set({
        execution_id: invocation.claim.executionId,
        holder_token: holderTag,
        state: "started-or-unknown",
        updated_at: new Date(),
      })
      .where("operation_id", "=", id)
      .execute();
    return {
      ...r,
      execution_id: invocation.claim.executionId,
      state: "started-or-unknown",
      holder_token: holderTag,
    };
  }
  private async scheduleExpiry(row: OperationIntent): Promise<void> {
    await this.outbox.add({
      queue: "cap-kernel-maintenance",
      name: OPERATION_RECONCILE,
      jobId: `${OPERATION_RECONCILE}-expiry-${row.operation_id}-${row.retain_until.getTime()}`,
      data: { operationId: row.operation_id },
      runAt: row.retain_until,
    });
  }
  /** Keep the consumed ID/hash and cleanup obligations; expired bytes cannot authorize replay. */
  @Transactional({ propagation: "requires_new" })
  async expirePayload(id: string): Promise<void> {
    const expired = await this.db
      .updateTable("sandbox_operation_intents")
      .set({ input: "null", result: JSON.stringify({ $expired: true }), updated_at: new Date() })
      .where("operation_id", "=", id)
      .where("retain_until", "<=", new Date())
      .returning("operation_id")
      .executeTakeFirst();
    if (expired) await this.payloads.expire(id);
  }
  /** Cleanup association only: a claimed dead holder can never authorize dispatch. */
  @Transactional({ propagation: "requires_new" })
  async revokeHolders(deviceId: string, tokens: readonly string[]): Promise<void> {
    if (!tokens.length) return;
    const device = await this.db
      .selectFrom("devices")
      .select("org_id")
      .where("id", "=", deviceId)
      .executeTakeFirst();
    if (!device) return;
    await this.locks.acquire({ orgId: device.org_id, deviceId }, { kind: "admit" });
    const rows = await this.db
      .updateTable("sandbox_operation_intents")
      .set({ state: "revoked", outcome_unknown: true, updated_at: new Date() })
      .where("device_id", "=", deviceId)
      .where("holder_token", "in", [...tokens])
      .where("state", "in", ["admitted", "dispatching", "started-or-unknown"])
      .returning("operation_id")
      .execute();
    for (const row of rows)
      await this.outbox.add({
        queue: "cap-kernel-maintenance",
        name: OPERATION_REVOKE,
        jobId: `${OPERATION_REVOKE}-${row.operation_id}`,
        data: { operationId: row.operation_id },
      });
  }
  /** A disconnected revoke remains owed; every retry is a new deterministic persisted attempt. */
  @Transactional({ propagation: "requires_new" })
  async deferRevocation(id: string): Promise<void> {
    const row = await this.db
      .updateTable("sandbox_operation_intents")
      .set((eb) => ({ reconcile_attempt: eb("reconcile_attempt", "+", 1), updated_at: new Date() }))
      .where("operation_id", "=", id)
      .where("state", "=", "revoked")
      .where("revoke_acknowledged", "=", false)
      .returning(["org_id", "reconcile_attempt"])
      .executeTakeFirst();
    if (row)
      await this.outbox.add({
        queue: "cap-kernel-maintenance",
        name: OPERATION_REVOKE,
        jobId: `${OPERATION_REVOKE}-${id}-${row.reconcile_attempt}`,
        data: { operationId: id },
        runAt: new Date(Date.now() + 30000),
      });
  }
  @Transactional({ propagation: "requires_new" })
  async acknowledgeRevocation(id: string): Promise<void> {
    await this.db
      .updateTable("sandbox_operation_intents")
      .set({ revoke_acknowledged: true, updated_at: new Date() })
      .where("operation_id", "=", id)
      .where("state", "=", "revoked")
      .execute();
  }
}
