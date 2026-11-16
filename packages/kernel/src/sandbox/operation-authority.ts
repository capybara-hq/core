import { randomUUID } from "node:crypto";
import {
  type DeviceExecGrants,
  type PermissionProfile,
  parseSandboxBrowseScope,
  parseSandboxOperationScope,
  type SandboxActor,
  type SandboxBrowseScope,
  type SandboxOperationScope,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import { PermissionProfileStore } from "../conversations/permission-profile-store.js";
import { ApiError } from "../errors.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import {
  TransactionHost,
  withTransactionFencePrelude,
} from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { NetworkGrants } from "../local-devices/network-grants.js";
import { coversHost } from "./modes.js";
import { isExecutionMethod, parseStartingExecutionGrants } from "./operation-authority-types.js";
import { PermissionAuthorityEpochStore } from "./permission-authority-epochs.js";
import { PermissionAuthorityLock } from "./permission-authority-lock.js";
import { PermissionCallGrants } from "./permission-call-grants.js";
import type { PermissionCallRef, PermissionReviewSnapshot } from "./permission-call-types.js";
import { PermissionConfigPublication } from "./permission-config-publication.js";
import { PermissionFacts, permissionScopeHash } from "./permission-facts.js";
import { normalizePermissionExpansion } from "./review/permission-candidate.js";
import type { SandboxUseContext } from "./use-context.js";
export type SandboxAuthorityOperation =
  | "exec"
  | "readFile"
  | "writeFile"
  | "stat"
  | "list"
  | "scan"
  | "backgroundStart";
export interface PermissionScopeFacts {
  operationId: string;
  admitBeforeMs: number;
  deviceId: string;
  rootConversationId: string;
  profileRevision: number;
  ceilingRevision: string;
  profile: PermissionProfile;
  actor: SandboxActor;
  tag: string;
  workingRoot: string;
  readRoots: readonly string[];
  writeRoots: readonly string[];
  allowedHosts: readonly string[];
  fullAccessCeiling: boolean;
  fullConsent?: boolean;
}
/** Only server-resolved facts enter this constructor; callers never submit roots or profile. */
export function intersectPermissionScope(f: PermissionScopeFacts): SandboxOperationScope {
  if (f.profile === "full-access" && (!f.fullConsent || !f.fullAccessCeiling))
    throw new ApiError(
      "forbidden",
      "Full access requires current device authority and matching consent",
    );
  return parseSandboxOperationScope({
    operationId: f.operationId,
    admitBeforeMs: f.admitBeforeMs,
    deviceId: f.deviceId,
    rootConversationId: f.rootConversationId,
    profileRevision: f.profileRevision,
    ceilingRevision: f.ceilingRevision,
    profile: f.profile,
    actor: f.actor,
    tag: f.tag,
    filesystem:
      f.profile === "full-access"
        ? { kind: "device" }
        : {
            kind: "scoped",
            readRoots: [...new Set([...f.readRoots, ...f.writeRoots])].sort(),
            writeRoots: [...new Set(f.writeRoots)].sort(),
          },
    network:
      f.profile === "full-access"
        ? { kind: "environment" }
        : f.allowedHosts.length
          ? { kind: "allowlist", hosts: [...new Set(f.allowedHosts)].sort() }
          : { kind: "none" },
  });
}
/** Fresh authority shape only. Provider dispatch must add durable admission fencing before use. */
@Injectable()
export class SandboxOperationAuthority {
  constructor(
    @Inject(PermissionCallGrants) private readonly callGrants: PermissionCallGrants,
    @Inject(PermissionConfigPublication) private readonly publication: PermissionConfigPublication,
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(PermissionProfileStore) private readonly profiles: PermissionProfileStore,
    @Inject(PermissionFacts) private readonly facts: PermissionFacts,
    @Inject(NetworkGrants) private readonly grants: NetworkGrants,
    @Inject(PermissionAuthorityLock) private readonly locks: PermissionAuthorityLock,
    @Inject(PermissionAuthorityEpochStore) private readonly epochs: PermissionAuthorityEpochStore,
  ) {}
  /** Owner project browsing has no conversation, profile, or fabricated root identity. */
  @Transactional()
  async resolveBrowse(
    ctx: { orgId: string; deviceId: string; accountId: string },
    signal: AbortSignal,
  ): Promise<SandboxBrowseScope> {
    signal.throwIfAborted();
    await this.locks.acquire({ orgId: ctx.orgId, deviceId: ctx.deviceId }, { kind: "admit" });
    await this.publication.assertCurrent();
    const member = await this.db
      .selectFrom("memberships as m")
      .innerJoin("accounts as a", "a.id", "m.account_id")
      .innerJoin("orgs as o", "o.id", "m.org_id")
      .select("m.account_id")
      .where("m.org_id", "=", ctx.orgId)
      .where("m.account_id", "=", ctx.accountId)
      .where("a.status", "=", "active")
      .where("o.deleted_at", "is", null)
      .executeTakeFirst();
    if (!member) throw new ApiError("device.not_found", "Device not found");
    await this.facts.preview(ctx.orgId, ctx.accountId, ctx.deviceId);
    const scope = await this.facts.projectScope(ctx.orgId, ctx.accountId, ctx.deviceId);
    if (!scope.supported || scope.widerThanAllowed)
      throw new ApiError(
        "device.projects_unsupported",
        "Current owner and organization ceilings do not permit browsing",
      );
    const operationId = randomUUID();
    const vector = await this.epochs.readLocked({ orgId: ctx.orgId, deviceId: ctx.deviceId });
    return parseSandboxBrowseScope({
      operationId,
      deviceId: ctx.deviceId,
      accountId: ctx.accountId,
      admitBeforeMs: Date.now() + 30000,
      ceilingRevision: permissionScopeHash(vector),
      readRoots: scope.mode === "auto" ? ["/"] : [scope.workspace],
      tag: operationId,
    });
  }
  /** Server-owned approval provenance, persisted with admission rather than inferred from scope hosts. */
  async grantedHosts(ctx: SandboxUseContext): Promise<string[]> {
    if (!ctx.actor.runId) return [];
    return [
      ...((
        await this.grants.forExec({
          orgId: ctx.orgId,
          deviceId: ctx.deviceId,
          runId: ctx.actor.runId,
        })
      )?.hosts ?? []),
    ];
  }
  async subjectFor(ctx: SandboxUseContext) {
    const root = await this.profiles.readOwnedRoot(
      ctx.orgId,
      ctx.holderConversationId,
      ctx.actor.accountId,
    );
    return { orgId: ctx.orgId, deviceId: ctx.deviceId, rootConversationId: root.id };
  }
  async previewCall(
    ctx: SandboxUseContext,
    call: PermissionCallRef,
    signal: AbortSignal,
  ): Promise<PermissionReviewSnapshot> {
    const subject = await this.subjectFor(ctx);
    return withTransactionFencePrelude(
      () => this.locks.acquire(subject, { kind: "admit" }),
      () => this.previewLocked(ctx, call, signal),
    );
  }
  @Transactional()
  private async previewLocked(
    ctx: SandboxUseContext,
    call: PermissionCallRef,
    signal: AbortSignal,
  ): Promise<PermissionReviewSnapshot> {
    const snapshot = await this.snapshot(ctx, call, signal);
    const messages = await this.db
      .selectFrom("conversation_events")
      .select("payload")
      .where("conversation_id", "=", ctx.holderConversationId)
      .where("run_id", "=", call.runId)
      .where("type", "=", "assistant_message")
      .execute();
    if (
      !messages.some(
        (row) =>
          Array.isArray((row.payload as { content?: unknown }).content) &&
          (row.payload as { content: unknown[] }).content.some(
            (v: unknown) =>
              v !== null &&
              typeof v === "object" &&
              "type" in v &&
              v.type === "tool_call" &&
              "id" in v &&
              v.id === call.callId,
          ),
      )
    )
      throw new ApiError("forbidden", "The permission review has no recorded tool call");
    return snapshot;
  }
  @Transactional()
  async resolve(
    ctx: SandboxUseContext,
    operation: SandboxAuthorityOperation,
    signal: AbortSignal,
  ): Promise<SandboxOperationScope> {
    const f = await this.snapshot(ctx, { runId: ctx.actor.runId ?? "", callId: "" }, signal);
    return this.scopeOf(ctx, operation, f);
  }
  @Transactional()
  async resolveInvocation(
    ctx: SandboxUseContext,
    operation: SandboxAuthorityOperation,
    call: PermissionCallRef,
    signal: AbortSignal,
  ) {
    let networkGrant: DeviceExecGrants | undefined;
    const f = await this.snapshot(ctx, call, signal, (grant) => {
      networkGrant = grant;
    });
    const started = await this.db
      .selectFrom("conversation_events")
      .select("payload")
      .where("conversation_id", "=", ctx.holderConversationId)
      .where("run_id", "=", call.runId)
      .where("type", "=", "tool_call_started")
      .where(sql<string>`payload->>'callId'`, "=", call.callId)
      .executeTakeFirst();
    if (!started) throw new ApiError("forbidden", "The operation has no canonical started call");
    const payload = started.payload as {
      toolKey?: string;
      specHash?: string;
      permissionInput?: { callInputHash: string; resolvedInputHash: string };
    };
    const {
      orgId,
      rootConversationId,
      conversationId,
      deviceId,
      accountId,
      runId,
      callId,
      profile,
      profileRevision,
      scopeRevision,
      authorityRevision,
    } = f;
    const grant =
      payload.toolKey && payload.specHash && payload.permissionInput
        ? await this.callGrants.findForAdmission({
            orgId,
            rootConversationId,
            conversationId,
            deviceId,
            accountId,
            runId,
            callId,
            profile,
            profileRevision,
            scopeRevision,
            authorityRevision,
            toolKey: payload.toolKey,
            specHash: payload.specHash,
            ...payload.permissionInput,
          })
        : null;
    if (grant) {
      normalizePermissionExpansion(grant.expansion, f);
      if (
        (!f.fullAccessCeiling &&
          (grant.expansion.readDirectories.length || grant.expansion.writeDirectories.length)) ||
        grant.expansion.hosts.some(
          (host) =>
            f.policy.network.kind !== "open-public" &&
            !f.policy.network.hosts.some((pattern) => coversHost(pattern, host)),
        )
      )
        throw new ApiError("forbidden", "Permission expansion exceeds the current ceiling");
    }
    const scope = this.scopeOf(ctx, operation, {
      ...f,
      baseReadDirectories: [...f.baseReadDirectories, ...(grant?.expansion.readDirectories ?? [])],
      baseWriteDirectories: [
        ...f.baseWriteDirectories,
        ...(grant?.expansion.writeDirectories ?? []),
      ],
      baseHosts: [...f.baseHosts, ...(grant?.expansion.hosts ?? [])],
    });
    const hosts = isExecutionMethod(operation)
      ? [...new Set([...(networkGrant?.hosts ?? []), ...(grant?.expansion.hosts ?? [])])].sort()
      : [];
    const executionGrants = isExecutionMethod(operation)
      ? parseStartingExecutionGrants({
          version: 1,
          grants: hosts.length
            ? {
                hosts,
                // The accepted per-call addition takes source precedence over the run/task envelope.
                source: grant?.expansion.hosts.length
                  ? { kind: "run", id: call.runId, accountId: ctx.actor.accountId }
                  : networkGrant?.source,
              }
            : null,
        })
      : null;
    return { scope, permissionGrantId: grant?.id ?? null, grantedHosts: hosts, executionGrants };
  }

  private scopeOf(
    ctx: SandboxUseContext,
    operation: SandboxAuthorityOperation,
    f: PermissionReviewSnapshot,
  ): SandboxOperationScope {
    if (
      !["exec", "readFile", "writeFile", "stat", "list", "scan", "backgroundStart"].includes(
        operation,
      )
    )
      throw new ApiError("forbidden", "Unknown sandbox operation");
    const operationId = randomUUID();
    return intersectPermissionScope({
      operationId,
      admitBeforeMs: Date.now() + 30000,
      deviceId: ctx.deviceId,
      rootConversationId: f.rootConversationId,
      profileRevision: f.profileRevision,
      ceilingRevision: f.authorityRevision,
      profile: f.profile,
      actor: ctx.actor,
      tag: operationId,
      workingRoot: f.workingRoot,
      readRoots: f.baseReadDirectories,
      writeRoots: f.baseWriteDirectories,
      allowedHosts: isExecutionMethod(operation) ? f.baseHosts : [],
      fullAccessCeiling: f.fullAccessCeiling,
      fullConsent: f.fullConsent,
    });
  }
  @Transactional({ propagation: "mandatory" })
  private async snapshot(
    ctx: SandboxUseContext,
    call: PermissionCallRef,
    signal: AbortSignal,
    captureGrant?: (grant: DeviceExecGrants | undefined) => void,
  ): Promise<PermissionReviewSnapshot> {
    signal.throwIfAborted();
    if (ctx.actor.runId && call.runId !== ctx.actor.runId)
      throw new ApiError("forbidden", "Permission call does not match its run");
    if (ctx.actor.conversationId !== ctx.holderConversationId)
      throw new ApiError("forbidden", "Operation actor does not match its conversation");
    const initial = await this.profiles.readOwnedRoot(
      ctx.orgId,
      ctx.holderConversationId,
      ctx.actor.accountId,
    );
    await this.facts.view(ctx.orgId, ctx.actor.accountId, initial);
    const subject = {
      orgId: ctx.orgId,
      deviceId: ctx.deviceId,
      rootConversationId: initial.id,
    };
    await this.locks.acquire(subject, { kind: "admit" });
    await this.publication.assertCurrent();
    const root = await this.profiles.readOwnedRoot(
      ctx.orgId,
      ctx.holderConversationId,
      ctx.actor.accountId,
    );
    const view = await this.facts.view(ctx.orgId, ctx.actor.accountId, root);
    if (view.deviceId !== ctx.deviceId)
      throw new ApiError("device.not_found", "The conversation is not bound to this device");
    await this.facts.preview(
      ctx.orgId,
      ctx.actor.accountId,
      ctx.deviceId,
      root.project_name ?? undefined,
    );
    let unattended = root.scheduled_task_id !== null;
    if (ctx.actor.runId) {
      const run = await this.db
        .selectFrom("runs")
        .select(["conversation_id", "trigger_account_id", "scheduled_task_run_id", "status"])
        .where("id", "=", ctx.actor.runId)
        .executeTakeFirst();
      if (
        !run ||
        run.conversation_id !== ctx.holderConversationId ||
        run.trigger_account_id !== ctx.actor.accountId ||
        !["running", "queued", "waiting"].includes(run.status)
      )
        throw new ApiError("forbidden", "The operation run is no longer authorized");
      unattended ||= run.scheduled_task_run_id !== null;
    }
    const { policy, owner } = await this.facts.readDevice(ctx.orgId, ctx.deviceId);
    const device = await this.db
      .selectFrom("devices")
      .select("source")
      .where("id", "=", ctx.deviceId)
      .executeTakeFirstOrThrow();
    const working = await this.facts.readWorkingFacts({
      orgId: ctx.orgId,
      rootConversationId: view.rootConversationId,
      holderConversationId: ctx.holderConversationId,
      deviceId: ctx.deviceId,
    });
    if (
      root.project_name &&
      root.project_path &&
      !(await this.facts.projectMatches(ctx.deviceId, root.project_name, root.project_path))
    )
      throw new ApiError("conflict", "The conversation project binding changed");
    const workingRoot = root.project_path ?? working.workspace;
    const grant = ctx.actor.runId
      ? await this.grants.forExec({
          orgId: ctx.orgId,
          deviceId: ctx.deviceId,
          runId: ctx.actor.runId,
        })
      : undefined;
    const baseHosts = owner ? owner.allowedDomains : policy.localAllowedDomains;
    const requested = [...baseHosts, ...(grant?.hosts ?? [])];
    const allowedHosts = requested.filter(
      (host) =>
        (policy.localAllowedDomains.some((pattern) => coversHost(pattern, host)) ||
          grant?.hosts.includes(host)) &&
        (policy.network.kind === "open-public" ||
          policy.network.hosts.some((pattern) => coversHost(pattern, host))),
    );
    captureGrant?.(
      grant
        ? {
            hosts: grant.hosts.filter((host) => allowedHosts.includes(host)).sort(),
            source: { ...grant.source },
          }
        : undefined,
    );
    const vector = await this.epochs.readLocked(subject);
    signal.throwIfAborted();
    if (!view.scopeRevision)
      throw new ApiError("forbidden", "Device permission scope is unavailable");
    return {
      orgId: ctx.orgId,
      rootConversationId: view.rootConversationId,
      conversationId: ctx.holderConversationId,
      deviceId: ctx.deviceId,
      accountId: ctx.actor.accountId,
      runId: call.runId,
      callId: call.callId,
      profile: unattended ? "request-approval" : view.profile,
      profileRevision: view.revision,
      scopeRevision: view.scopeRevision,
      authorityRevision: permissionScopeHash({ scopeRevision: view.scopeRevision, vector }),
      workingRoot,
      baseReadDirectories: [workingRoot],
      baseWriteDirectories: [workingRoot],
      baseHosts: allowedHosts,
      fullAccessCeiling: view.fullAccessCeiling,
      fullConsent:
        view.profile === "full-access" && view.consentScope?.scopeRevision === view.scopeRevision,
      unattended,
      availability: view.availability,
      policy:
        device.source === "local"
          ? { ...policy, network: { kind: "allowlist", hosts: policy.localAllowedDomains } }
          : policy,
    };
  }
}
