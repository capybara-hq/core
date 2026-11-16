import { createHash } from "node:crypto";
import {
  parseSandboxOperationScope,
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
import type { NativeMethod } from "./held-operations.js";
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
export function operationIdFor(i: OperationInvocation): string {
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
    method: NativeMethod,
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
        admission_hash: permissionScopeHash({ method, inputDigest: described.digest, scope }),
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
          admission_hash: permissionScopeHash({ method, inputDigest: described.digest, scope }),
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
    method: NativeMethod,
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
    } = await this.authority.resolveInvocation(
      ctx,
      r.method,
      { runId: invocation.claim.runId, callId: invocation.callId },
      new AbortController().signal,
    );
    if (
      permissionGrantId !== r.permission_grant_id ||
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
    if (r.state === "completed") return r;
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
    method: NativeMethod,
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
    if (r.state === "completed") return r;
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
