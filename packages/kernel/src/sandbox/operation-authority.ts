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
import {
  type PermissionContextV1,
  PermissionContextV1Schema,
  permissionCodePointCompare,
} from "../conversations/events.js";
import {
  PermissionProfileStore,
  type PermissionRoot,
} from "../conversations/permission-profile-store.js";
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
import { assertAuthorityHeld, PermissionAuthorityLock } from "./permission-authority-lock.js";
import type { PermissionAvailability } from "./permission-availability.js";
import { PermissionCallGrants } from "./permission-call-grants.js";
import type { PermissionCallRef, PermissionReviewSnapshot } from "./permission-call-types.js";
import { PermissionConfigPublication } from "./permission-config-publication.js";
import type { AppliedEnvironment } from "./permission-context-types.js";
import {
  type PermissionContextSubject,
  PermissionContextSubjectChanged,
} from "./permission-context-types.js";
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
const UNPROVED_ENVIRONMENT =
  "The device's installed environment is not verified yet; it is checked when the device starts";
/** A device state for which the recorded context carries no scope and admission refuses. */
type WithheldScope = { state: "unsupported" | "unprobed"; reason: string };
/**
 * The one verdict over a device's runtime report and its applied environment (B1, B-16): the
 * recorded permission context withholds its scope exactly when this returns a verdict, and
 * admission refuses with the same reason, so the model is never told it can do what admission
 * refuses, nor the reverse (on a cloud device admission applies it only once installed cloud
 * evidence exists, B-15). Unknown applied facts precede a positive capability report; a working
 * root that is not the installed workspace (no project) is never installed scope.
 */
function withheldScope(input: {
  availability: PermissionAvailability;
  effectiveProfile: PermissionProfile;
  location: "local" | "cloud";
  workingRoot: string;
  projectPath: string | null;
  applied: AppliedEnvironment | null;
}): WithheldScope | null {
  const { availability, applied } = input;
  if (availability.state !== "supported")
    return { state: availability.state, reason: availability.reason };
  if (
    applied === null ||
    applied.location !== input.location ||
    (input.projectPath === null && input.workingRoot !== applied.roots.workspace)
  )
    return { state: "unprobed", reason: UNPROVED_ENVIRONMENT };
  if (input.effectiveProfile === "full-access") {
    if (!availability.report.fullAccess)
      return { state: "unsupported", reason: "This device's runtime cannot run Full access" };
  } else if (availability.report.restricted === null)
    return {
      state: "unsupported",
      reason: "This device's runtime cannot enforce the restricted permission profiles",
    };
  return null;
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
    await this.facts.assertCloudReconciled(ctx.orgId, ctx.deviceId);
    await this.facts.assertOwnerReportUsable(ctx.orgId, ctx.deviceId);
    if (!(await this.isActiveMember(ctx.orgId, ctx.accountId)))
      throw new ApiError("device.not_found", "Device not found");
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
      readRoots: scope.reach === "os-user" ? ["/"] : [scope.workspace],
      tag: operationId,
    });
  }
  /**
   * The one actor liveness predicate of owner browsing, the recorded permission context and the
   * managed device context writer: an active account that is still a member of a live org.
   */
  async isActiveMember(orgId: string, accountId: string): Promise<boolean> {
    const member = await this.db
      .selectFrom("memberships as m")
      .innerJoin("accounts as a", "a.id", "m.account_id")
      .innerJoin("orgs as o", "o.id", "m.org_id")
      .select("m.account_id")
      .where("m.org_id", "=", orgId)
      .where("m.account_id", "=", accountId)
      .where("a.status", "=", "active")
      .where("o.deleted_at", "is", null)
      .executeTakeFirst();
    return member !== undefined;
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
        (!f.broadProjectReach &&
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
    // the recorded context withholds its scope for exactly these states (B-16)
    if (f.admissionRefusal) throw new ApiError("forbidden", f.admissionRefusal);
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
    // the recorded context's actor predicate: a disabled or removed actor is refused alike (B-19)
    if (!(await this.isActiveMember(ctx.orgId, ctx.actor.accountId)))
      throw new ApiError("forbidden", "This run's actor is no longer authorized");
    await this.publication.assertCurrent();
    await this.facts.assertCloudReconciled(ctx.orgId, ctx.deviceId);
    await this.facts.assertOwnerReportUsable(ctx.orgId, ctx.deviceId);
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
    if (ctx.actor.runId)
      unattended ||= await this.runScheduledLocked(
        ctx.holderConversationId,
        ctx.actor.accountId,
        ctx.actor.runId,
      );
    const { policy, device, workingRoot, grant, allowedHosts } = await this.baseScopeLocked({
      orgId: ctx.orgId,
      deviceId: ctx.deviceId,
      root,
      holderConversationId: ctx.holderConversationId,
      runId: ctx.actor.runId,
    });
    captureGrant?.(
      grant
        ? {
            hosts: grant.hosts.filter((host) => allowedHosts.includes(host)).sort(),
            source: { ...grant.source },
          }
        : undefined,
    );
    const effectiveProfile: PermissionProfile = unattended ? "request-approval" : view.profile;
    // B-15 (W2-H1): a cloud device records its runtime report and installed evidence only after
    // the provisioning its first admitted operation causes, so cloud admission keeps its previous
    // rule meanwhile (its recorded context stays unprobed: narrower, never wider); H1 records the
    // cloud evidence and removes this exception
    const withheld =
      device.source === "local"
        ? withheldScope({
            availability: view.availability,
            effectiveProfile,
            location: "local",
            workingRoot,
            projectPath: root.project_path,
            applied: await this.facts.readAppliedEnvironmentLocked({
              orgId: ctx.orgId,
              deviceId: ctx.deviceId,
            }),
          })
        : null;
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
      profile: effectiveProfile,
      profileRevision: view.revision,
      scopeRevision: view.scopeRevision,
      authorityRevision: permissionScopeHash({ scopeRevision: view.scopeRevision, vector }),
      workingRoot,
      baseReadDirectories: [workingRoot],
      baseWriteDirectories: [workingRoot],
      baseHosts: allowedHosts,
      fullAccessCeiling: view.fullAccessCeiling,
      broadProjectReach: view.broadProjectReach,
      fullConsent:
        view.profile === "full-access" && view.consentScope?.scopeRevision === view.scopeRevision,
      unattended,
      // the review and admission see the recorded context's verdict, never a wider one
      availability: withheld ?? view.availability,
      admissionRefusal: withheld?.reason ?? null,
      policy:
        device.source === "local"
          ? { ...policy, network: { kind: "allowlist", hosts: policy.localAllowedDomains } }
          : policy,
    };
  }

  /**
   * The actual run of an operation or context read: still this conversation's, triggered by this
   * actor and not ended; true when it serves a scheduled task run (an unattended child or wake
   * included). Shared by admission and the recorded permission context.
   */
  private async runScheduledLocked(
    conversationId: string,
    accountId: string,
    runId: string,
  ): Promise<boolean> {
    const run = await this.db
      .selectFrom("runs")
      .select(["conversation_id", "trigger_account_id", "scheduled_task_run_id", "status"])
      .where("id", "=", runId)
      .executeTakeFirst();
    if (
      !run ||
      run.conversation_id !== conversationId ||
      run.trigger_account_id !== accountId ||
      !["running", "queued", "waiting"].includes(run.status)
    )
      throw new ApiError("forbidden", "The operation run is no longer authorized");
    return run.scheduled_task_run_id !== null;
  }

  /**
   * The call-independent base authority of a device for one root (B1): the device's policy and
   * owner facts, its working root (the validated project binding, else the recorded or reported
   * workspace) and the restricted base hosts after the owner and organization ceilings, including
   * the run's network grants and an unattended run's explicit task grants. No call expansion, no
   * operation, no provider call. Admission and the recorded permission context both read it here.
   */
  private async baseScopeLocked(input: {
    orgId: string;
    deviceId: string;
    root: PermissionRoot;
    holderConversationId: string;
    runId: string | undefined;
  }) {
    const { orgId, deviceId } = input;
    const { policy, owner } = await this.facts.readDevice(orgId, deviceId);
    const device = await this.db
      .selectFrom("devices")
      .select("source")
      .where("id", "=", deviceId)
      .executeTakeFirstOrThrow();
    const workingRoot = await this.workingRootOf(input);
    const grant = input.runId
      ? await this.grants.forExec({ orgId, deviceId, runId: input.runId })
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
    return { policy, device, workingRoot, grant, allowedHosts };
  }

  /**
   * The working root of the base authority (B1): the validated project binding, else the recorded
   * or reported workspace. Admission, the recorded permission context and the managed device
   * context evidence all resolve it here, so none of them can name a wider root than admission.
   */
  private async workingRootOf(input: {
    orgId: string;
    deviceId: string;
    root: PermissionRoot;
    holderConversationId: string;
  }): Promise<string> {
    const { orgId, deviceId, root } = input;
    const working = await this.facts.readWorkingFacts({
      orgId,
      rootConversationId: root.id,
      holderConversationId: input.holderConversationId,
      deviceId,
    });
    if (
      root.project_name &&
      root.project_path &&
      !(await this.facts.projectMatches(deviceId, root.project_name, root.project_path))
    )
      throw new ApiError("conflict", "The conversation project binding changed");
    return root.project_path ?? working.workspace;
  }

  /**
   * The base working root of the calling conversation's tree on `deviceId` (see
   * {@link workingRootOf}): read without locks as a managed operation's held evidence, and again
   * under the complete authority subject by the managed device context writer, which compares the
   * two. Throws `conflict` when the project binding no longer matches the device.
   */
  async workingRootFor(input: {
    orgId: string;
    deviceId: string;
    conversationId: string;
  }): Promise<string> {
    const root = await this.profiles.readRoot(input.orgId, input.conversationId);
    return this.workingRootOf({
      orgId: input.orgId,
      deviceId: input.deviceId,
      root,
      holderConversationId: input.conversationId,
    });
  }

  /**
   * The recorded permission context of a run's next request (B1): the same base facts admission
   * reads, projected without any call, operation, grant expansion or provider effect. The caller
   * already holds the complete authority subject (platform, org, device when selected, root) in
   * this transaction; a subject those locks do not cover throws
   * {@link PermissionContextSubjectChanged}. A missing or inaccessible actor, root or run throws
   * (no request is sent); a device this actor cannot use is the logged access refusal; device
   * states admission refuses are unsupported or unprobed contexts without a scope.
   */
  @Transactional({ propagation: "mandatory" })
  async readContextLocked(
    input: PermissionContextSubject,
    signal: AbortSignal,
  ): Promise<PermissionContextV1> {
    signal.throwIfAborted();
    const root = await this.profiles.readOwnedRoot(
      input.orgId,
      input.conversationId,
      input.accountId,
    );
    const held = (kind: "platform" | "org" | "device" | "root", id: string) => {
      try {
        assertAuthorityHeld(kind, id);
        return true;
      } catch {
        return false;
      }
    };
    if (
      !held("platform", "platform") ||
      !held("org", input.orgId) ||
      !held("root", root.id) ||
      (root.device_id !== null && !held("device", root.device_id))
    )
      throw new PermissionContextSubjectChanged();
    if (!(await this.isActiveMember(input.orgId, input.accountId)))
      throw new ApiError("forbidden", "This run's actor is no longer authorized");
    await this.publication.assertCurrent();
    const scheduled =
      (await this.runScheduledLocked(input.conversationId, input.accountId, input.runId)) ||
      root.scheduled_task_id !== null;
    const header = {
      version: 1 as const,
      rootConversationId: root.id,
      execution: scheduled ? ("scheduled" as const) : ("interactive" as const),
      inherited: input.conversationId !== root.id,
    };
    const parse = (payload: PermissionContextV1) => {
      signal.throwIfAborted();
      return PermissionContextV1Schema.parse(payload);
    };
    const { view, access } = await this.facts.viewWithAccess(input.orgId, input.accountId, root);
    if (root.device_id === null || access === "no-device")
      return parse({
        ...header,
        profileRevision: root.permission_revision,
        selectedProfile: root.permission_profile,
        effectiveProfile: null,
        deviceId: null,
        scopeRevision: null,
        authorityRevision: null,
        availability: {
          state: "unavailable",
          cause: "no-device",
          reason: "Choose a device to run device operations",
        },
        scope: null,
      });
    if (access === "actor-device-access")
      return parse({
        ...header,
        profileRevision: null,
        selectedProfile: null,
        effectiveProfile: null,
        deviceId: null,
        scopeRevision: null,
        authorityRevision: null,
        availability: {
          state: "unavailable",
          cause: "actor-device-access",
          reason: "This run's actor cannot use the selected device",
        },
        scope: null,
      });
    const deviceId = root.device_id;
    const scopeRevision =
      access === "provider-unavailable"
        ? (await this.facts.scope(input.orgId, deviceId, root.project_path, root.project_name))
            .scopeRevision
        : view.scopeRevision;
    if (!scopeRevision) throw new Error("Device permission scope revision is missing");
    const vector = await this.epochs.readLocked({
      orgId: input.orgId,
      deviceId,
      rootConversationId: root.id,
    });
    const effectiveProfile: PermissionProfile = scheduled ? "request-approval" : view.profile;
    const known = {
      ...header,
      profileRevision: root.permission_revision,
      selectedProfile: root.permission_profile,
      effectiveProfile,
      deviceId,
      scopeRevision,
      authorityRevision: permissionScopeHash({ scopeRevision, vector }),
    };
    const without = (state: "unsupported" | "unprobed", reason: string) =>
      parse({ ...known, availability: { state, reason }, scope: null });
    const availability = view.availability;
    if (access === "provider-unavailable")
      return without(
        "unsupported",
        availability.state === "supported"
          ? "This device's provider is not available"
          : availability.reason,
      );
    if (availability.state !== "supported") return without(availability.state, availability.reason);
    // states admission refuses before any operation: the device is not verified for new work
    try {
      await this.facts.assertCloudReconciled(input.orgId, deviceId);
      await this.facts.assertOwnerReportUsable(input.orgId, deviceId);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      return without("unprobed", error.message);
    }
    let base: Awaited<ReturnType<SandboxOperationAuthority["baseScopeLocked"]>>;
    try {
      await this.facts.preview(
        input.orgId,
        input.accountId,
        deviceId,
        root.project_name ?? undefined,
      );
      base = await this.baseScopeLocked({
        orgId: input.orgId,
        deviceId,
        root,
        holderConversationId: input.conversationId,
        runId: input.runId,
      });
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      return without("unsupported", error.message);
    }
    const applied = await this.facts.readAppliedEnvironmentLocked({
      orgId: input.orgId,
      deviceId,
    });
    const location = base.device.source === "local" ? "local" : "cloud";
    // the verdict admission refuses with (B-16)
    const withheld = withheldScope({
      availability,
      effectiveProfile,
      location,
      workingRoot: base.workingRoot,
      projectPath: root.project_path,
      applied,
    });
    if (withheld) return without(withheld.state, withheld.reason);
    if (applied === null) throw new Error("A supported context needs its applied environment");
    const full = effectiveProfile === "full-access";
    if (
      full &&
      (!view.fullAccessCeiling ||
        view.consentScope?.deviceId !== deviceId ||
        view.consentScope.scopeRevision !== scopeRevision)
    )
      throw new Error("Full access lost its ceiling or consent inside one authority read");
    const hosts = [...new Set(base.allowedHosts)].sort(permissionCodePointCompare);
    return parse({
      ...known,
      availability: { state: "supported" },
      scope: {
        location,
        workingRoot: base.workingRoot,
        filesystem: full
          ? { kind: "device" }
          : {
              kind: "scoped",
              readDirectories: [base.workingRoot],
              writeDirectories: [base.workingRoot],
            },
        network: full
          ? { kind: "environment" }
          : hosts.length
            ? { kind: "allowlist", hosts }
            : { kind: "none" },
        outerNetwork: applied.outerNetwork,
      },
    });
  }
}
