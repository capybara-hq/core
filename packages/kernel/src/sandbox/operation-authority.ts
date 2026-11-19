import { randomUUID } from "node:crypto";
import {
  type DeviceExecGrants,
  type PermissionProfile,
  parseSandboxBrowseScope,
  parseSandboxOperationScope,
  type SandboxActor,
  type SandboxBoundary,
  type SandboxBrowseScope,
  type SandboxOperationScope,
  SandboxPermissionUnsupportedError,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import {
  ACTOR_DEVICE_ACCESS_REASON,
  ACTOR_NOT_DEVICE_OWNER_REASON,
  type PermissionContextV2,
  PermissionContextV2Schema,
  permissionCodePointCompare,
} from "../conversations/events.js";
import {
  PermissionProfileStore,
  type PermissionRoot,
} from "../conversations/permission-profile-store.js";
import { canonicalRoot, workingRootOf as reviewWorkingRootOf } from "../devices/working-root.js";
import { ApiError } from "../errors.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import {
  TransactionHost,
  withTransactionFencePrelude,
} from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { NetworkGrants } from "../local-devices/network-grants.js";
import type { DeviceSandbox } from "./device-sandbox.js";
import { hostGrantable } from "./device-sandbox.js";
import {
  type KernelReadInvocation,
  type KernelReadMethod,
  type KernelReadRoute,
  KernelReadUnsupported,
  kernelReadRoot,
  kernelReadRoute,
} from "./kernel-read.js";
import { coversHost, type EffectiveDevicePolicy, projectReachOf } from "./modes.js";
import {
  EscalationGrantMissingError,
  isExecutionMethod,
  parseStartingExecutionGrants,
} from "./operation-authority-types.js";
import { PermissionAuthorityEpochStore } from "./permission-authority-epochs.js";
import { assertAuthorityHeld, PermissionAuthorityLock } from "./permission-authority-lock.js";
import type { PermissionAvailability } from "./permission-availability.js";
import { PermissionCallGrants } from "./permission-call-grants.js";
import type { PermissionCallRef, PermissionReviewSnapshot } from "./permission-call-types.js";
import { PermissionConfigPublication } from "./permission-config-publication.js";
import type { AppliedEnvironment, AppliedOuterNetwork } from "./permission-context-types.js";
import {
  type PermissionContextSubject,
  PermissionContextSubjectChanged,
} from "./permission-context-types.js";
import { hostsWithinOuter, PermissionFacts, permissionScopeHash } from "./permission-facts.js";
import {
  ESCALATION_CEILING_WHY,
  ESCALATION_UNATTENDED_WHY,
  escalationRuntimeWhy,
  normalizePermissionExpansion,
  withinDirectory,
} from "./review/permission-candidate.js";
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
  /** The sandbox network of the call ({@link sandboxNetworkOf}); `allowlist` uses `allowedHosts`. */
  network: "open-public" | "allowlist" | "none";
  /** The provider's boundary: an `instance` device's scope is its whole filesystem. */
  boundary: SandboxBoundary;
  outsideSandboxCeiling: boolean;
  /**
   * An approved per-call sandbox escalation of this exact call (its immutable call grant): the
   * operation runs outside the sandbox, within the device's outside-sandbox ceiling, under any
   * profile. Only admission sets it, from the grant row; never a caller.
   */
  escalated?: boolean;
}
const UNPROVED_ENVIRONMENT =
  "The device's installed environment is not verified yet; it is checked when the device starts";
/** A device state for which the recorded context carries no scope and admission refuses. */
type WithheldScope = { state: "unsupported" | "unprobed"; reason: string };
/**
 * The one verdict over a device's runtime report and its applied environment (B1, B-16): the
 * recorded permission context withholds its scope exactly when this returns a verdict, and
 * admission refuses with the same reason, so the model is never told it can do what admission
 * refuses, nor the reverse (local and cloud devices alike, B-15). Unknown applied facts precede a
 * positive capability report; a working root that is not the installed workspace (no project) is
 * never installed scope. The sandbox is the same under every profile (support v2): a runtime that
 * enforces per-operation scopes, or an instance-boundary provider whose instance is the sandbox.
 */
function withheldScope(input: {
  availability: PermissionAvailability;
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
  // a local machine's sandbox is per operation; only a cloud provider's instance is the sandbox
  if (availability.report.boundary === "instance" && input.location === "local")
    return { state: "unsupported", reason: "A local device cannot report an instance boundary" };
  if (availability.report.restricted === null && availability.report.boundary !== "instance")
    return {
      state: "unsupported",
      reason:
        availability.report.unavailableReason ?? "This device's runtime cannot enforce its sandbox",
    };
  return null;
}
/**
 * The profile every kernel read is sent with: a restricted one, so the runtime enforces its single
 * read root (a symlink out of the project is refused) whatever the conversation selected.
 */
const KERNEL_READ_PROFILE: PermissionProfile = "request-approval";
/**
 * The sandbox network of a call: the device sandbox's mode within a cloud instance's applied outer
 * boundary (an open network never sits inside an allowlisted or disabled one); `allowlist` takes
 * the call's hosts, and an allowlist without hosts is `none` at the scope.
 */
export function sandboxNetworkOf(
  box: Pick<DeviceSandbox, "networkMode">,
  outer: AppliedOuterNetwork | null | undefined,
): "open-public" | "allowlist" | "none" {
  if (box.networkMode === "none" || outer?.kind === "none") return "none";
  if (box.networkMode === "open" && outer?.kind !== "allowlist") return "open-public";
  return "allowlist";
}
/** An instance-boundary device's scope: its whole filesystem, plus the working root it names. */
const instanceRoots = (workingRoot: string): string[] =>
  [...new Set(["/", workingRoot])].sort(permissionCodePointCompare);
/**
 * Only server-resolved facts enter this constructor; callers never submit roots or profile. It
 * never branches on the profile: every call is sandboxed (scoped filesystem, the sandbox network),
 * and only an escalated call within the outside-sandbox ceiling gets the device pair.
 */
export function intersectPermissionScope(f: PermissionScopeFacts): SandboxOperationScope {
  if (f.escalated && (!f.outsideSandboxCeiling || f.boundary === "instance"))
    throw new ApiError(
      "forbidden",
      "Running outside the sandbox requires the device's current outside-sandbox ceiling",
    );
  const escalated = f.escalated === true;
  const hosts = [...new Set(f.allowedHosts)].sort();
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
    filesystem: escalated
      ? { kind: "device" }
      : f.boundary === "instance"
        ? {
            kind: "scoped",
            readRoots: instanceRoots(f.workingRoot),
            writeRoots: instanceRoots(f.workingRoot),
          }
        : {
            kind: "scoped",
            readRoots: [...new Set([...f.readRoots, ...f.writeRoots])].sort(),
            writeRoots: [...new Set(f.writeRoots)].sort(),
          },
    network: escalated
      ? { kind: "environment" }
      : f.network === "open-public"
        ? { kind: "open-public" }
        : f.network === "allowlist" && hosts.length
          ? { kind: "allowlist", hosts }
          : { kind: "none" },
  });
}
/** Fresh authority shape only. Provider dispatch must add durable admission fencing before use. */
/**
 * The read roots of a restricted profile: the working root, plus the held instance's
 * kernel-staged skills root (its committed roots), read-only, so a staged skill's scripts run
 * (`sh /skills/<name>@<digest>/…`). Never writable; nothing else is added. Sorted by code point,
 * as the recorded context requires.
 */
export function restrictedReadRoots(
  workingRoot: string,
  applied: Pick<AppliedEnvironment, "roots"> | null | undefined,
): string[] {
  const skills = applied?.roots.skills;
  const roots =
    skills?.startsWith("/") && !withinDirectory(skills, workingRoot)
      ? [workingRoot, skills]
      : [workingRoot];
  return [...new Set(roots)].sort(permissionCodePointCompare);
}

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
      permissionInput?: {
        callInputHash: string;
        resolvedInputHash: string;
        sandbox?: "escalated";
      };
    };
    const permissionInput: {
      callInputHash: string | undefined;
      resolvedInputHash: string | undefined;
    } = {
      callInputHash: payload.permissionInput?.callInputHash,
      resolvedInputHash: payload.permissionInput?.resolvedInputHash,
    };
    const requested = payload.permissionInput?.sandbox;
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
      payload.toolKey &&
      payload.specHash &&
      permissionInput.callInputHash !== undefined &&
      permissionInput.resolvedInputHash !== undefined
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
            callInputHash: permissionInput.callInputHash,
            resolvedInputHash: permissionInput.resolvedInputHash,
          })
        : null;
    // outside the sandbox for this exact call's command only (a native method of the same call
    // keeps the base scope), under any profile: Full access auto-grants it, never skips the grant
    const escalated = grant?.scopeKind === "sandbox-escalation" && isExecutionMethod(operation);
    // a call that asked to run outside the sandbox runs escalated or not at all: a missed grant
    // (the device, ceiling or scope changed since the approval) or a ceiling that no longer allows
    // it is a pre-effect refusal, never a sandboxed run
    if (
      requested === "escalated" &&
      isExecutionMethod(operation) &&
      (!escalated || f.escalationRefusal)
    )
      throw new EscalationGrantMissingError(
        f.escalationRefusal
          ? `Sandbox escalation is unavailable: ${f.escalationRefusal}`
          : "The call's sandbox escalation grant no longer matches",
      );
    if (!escalated && grant && grant.scopeKind !== "sandbox-escalation") {
      normalizePermissionExpansion(grant.expansion, f);
      if (
        (!f.broadProjectReach &&
          (grant.expansion.readDirectories.length || grant.expansion.writeDirectories.length)) ||
        grant.expansion.hosts.some((host) =>
          f.hostCeiling
            ? !hostGrantable(f.hostCeiling, host)
            : f.policy.network.kind !== "open-public" &&
              !f.policy.network.hosts.some((pattern) => coversHost(pattern, host)),
        )
      )
        throw new ApiError("forbidden", "Permission expansion exceeds the current ceiling");
    }
    // an accepted host addition the applied cloud outer boundary does not cover cannot be
    // reached: cut like the base hosts, so admission never names more than the context (B-15);
    // an open sandbox network needs none, and an instance-boundary device takes none per call
    const expansionHosts =
      f.network === "allowlist" && f.boundary !== "instance"
        ? hostsWithinOuter(grant?.expansion.hosts ?? [], f.outerNetwork ?? undefined)
        : [];
    const scope = this.scopeOf(
      ctx,
      operation,
      {
        ...f,
        baseReadDirectories: [
          ...f.baseReadDirectories,
          ...(grant?.expansion.readDirectories ?? []),
        ],
        baseWriteDirectories: [
          ...f.baseWriteDirectories,
          ...(grant?.expansion.writeDirectories ?? []),
        ],
        baseHosts: [...f.baseHosts, ...expansionHosts],
      },
      escalated,
    );
    const hosts = isExecutionMethod(operation)
      ? [...new Set([...(networkGrant?.hosts ?? []), ...expansionHosts])].sort()
      : [];
    const executionGrants = isExecutionMethod(operation)
      ? parseStartingExecutionGrants({
          version: 1,
          grants: hosts.length
            ? {
                hosts,
                // The accepted per-call addition takes source precedence over the run/task envelope.
                source: expansionHosts.length
                  ? { kind: "run", id: call.runId, accountId: ctx.actor.accountId }
                  : networkGrant?.source,
              }
            : null,
        })
      : null;
    // an escalation grant is provenance of its command only, never of a native method's base scope
    const permissionGrantId =
      grant && (grant.scopeKind !== "sandbox-escalation" || escalated) ? grant.id : null;
    return { scope, permissionGrantId, grantedHosts: hosts, executionGrants };
  }

  /**
   * The scope of one kernel read (permission activation L2, Hook 1): the conversation's profile
   * scope from the same authority snapshot admission reads, with the bound project as the working
   * root it becomes once read (the review's fallbacks apply: a root outside the mode or above the
   * home is refused), intersected with the one path the read may reach
   * ({@link kernelReadRoot}: the root's `stat`, `AGENTS.md`, `.agents/skills/**`). The restricted
   * {@link KERNEL_READ_PROFILE} whenever the runtime enforces it (the runtime then enforces the
   * read root, symlinks included); the conversation's admitted Full access only on an isolated
   * Full-only runtime; a host machine without restricted enforcement throws
   * {@link KernelReadUnsupported} ({@link kernelReadRoute}). No write roots, no hosts, never a
   * per-call grant. Called under the run start's claim only (the intents
   * check that its run is still `queued`).
   */
  @Transactional()
  async resolveKernelRead(
    ctx: SandboxUseContext,
    read: Pick<KernelReadInvocation, "purpose" | "root">,
    method: KernelReadMethod,
    path: string,
    signal: AbortSignal,
  ): Promise<SandboxOperationScope> {
    if (read.purpose !== "project_root")
      throw new ApiError("forbidden", "Unknown kernel read purpose");
    const covering = kernelReadRoot(read.root, method, path);
    if (covering === null)
      throw new ApiError(
        "forbidden",
        "A kernel read reaches only the project's root, its AGENTS.md and its .agents/skills",
      );
    const f = await this.snapshot(
      ctx,
      { runId: ctx.actor.runId ?? "", callId: "" },
      signal,
      undefined,
      { projectUsable: true },
    );
    const bound = await this.profiles.readOwnedRoot(
      ctx.orgId,
      ctx.holderConversationId,
      ctx.actor.accountId,
    );
    if (
      bound.project_path === null ||
      canonicalRoot(bound.project_path) !== canonicalRoot(read.root) ||
      canonicalRoot(f.workingRoot) !== canonicalRoot(read.root)
    )
      throw new ApiError(
        "forbidden",
        "The kernel read's root is not the conversation's usable project root",
      );
    // the recorded runtime support decides the route: restricted when enforced, Full access only
    // on an isolated Full-only runtime, nothing on a host machine without restricted enforcement
    const availability = f.availability as PermissionAvailability;
    // a runtime that cannot enforce its sandbox (one that only runs outside it) gets no read
    if (availability.state === "unsupported") throw new KernelReadUnsupported();
    let route: KernelReadRoute = "restricted";
    if (availability.state === "supported") {
      route = kernelReadRoute({
        restricted:
          availability.report.restricted !== null || availability.report.boundary === "instance",
        fullAccess: availability.report.outsideSandbox,
        isolated: await this.isolatedRuntime(ctx.orgId, ctx.deviceId),
      });
      if (route === "refused") throw new KernelReadUnsupported();
    }
    const profile = this.scopeOf(ctx, method, f);
    if (
      profile.filesystem.kind === "scoped" &&
      !profile.filesystem.readRoots.some(
        (r) => covering === r || covering.startsWith(r === "/" ? "/" : `${r}/`),
      )
    )
      throw new ApiError("forbidden", "The kernel read is outside the conversation's profile");
    // a restricted read-only scope whenever the runtime enforces it, whatever the conversation's
    // profile: a runtime keyed on Full access may follow a symlinked AGENTS.md or SKILL.md out of
    // the project, and a kernel read has no tool call or review to show for it
    return parseSandboxOperationScope({
      ...profile,
      profile: route === "full" ? profile.profile : KERNEL_READ_PROFILE,
      filesystem: { kind: "scoped", readRoots: [covering], writeRoots: [] },
      network: { kind: "none" },
    });
  }

  /**
   * Whether the device's runtime is isolated from its host's files (a kernel read may then go
   * under the conversation's Full access on a Full-only runtime): a cloud device, or a local
   * machine whose authenticated connection recorded its Docker mode (`device_machines.mode`,
   * written at hello; a mode change resets the device's files).
   */
  private async isolatedRuntime(orgId: string, deviceId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom("devices as d")
      .leftJoin("device_machines as m", (j) =>
        j.onRef("m.device_id", "=", "d.id").on("m.revoked_at", "is", null),
      )
      .select(["d.source", "m.mode"])
      .where("d.id", "=", deviceId)
      .where("d.org_id", "=", orgId)
      .executeTakeFirst();
    return row !== undefined && (row.source !== "local" || row.mode === "docker");
  }

  private scopeOf(
    ctx: SandboxUseContext,
    operation: SandboxAuthorityOperation,
    f: PermissionReviewSnapshot,
    escalated = false,
  ): SandboxOperationScope {
    if (
      !["exec", "readFile", "writeFile", "stat", "list", "scan", "backgroundStart"].includes(
        operation,
      )
    )
      throw new ApiError("forbidden", "Unknown sandbox operation");
    // the recorded context withholds its scope for exactly these states (B-16)
    if (f.admissionRefusal) {
      // a runtime that cannot enforce the profile is the typed pre-effect refusal: the model gets
      // the actionable unsupported text, never the generic "may not have completed" one
      if (f.availability.state === "unsupported")
        throw new SandboxPermissionUnsupportedError(f.admissionRefusal);
      throw new ApiError("forbidden", f.admissionRefusal);
    }
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
      // a native method reaches no network: only executions carry the sandbox network
      network: isExecutionMethod(operation) ? (f.network ?? "none") : "none",
      boundary: f.boundary ?? "operation",
      outsideSandboxCeiling: f.outsideSandboxCeiling,
      ...(escalated ? { escalated: true } : {}),
    });
  }
  @Transactional({ propagation: "mandatory" })
  private async snapshot(
    ctx: SandboxUseContext,
    call: PermissionCallRef,
    signal: AbortSignal,
    captureGrant?: (grant: DeviceExecGrants | undefined) => void,
    opts: { projectUsable?: true } = {},
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
    // the recorded context's actor predicate: a disabled or removed actor is refused alike (B-19).
    // Both readers refuse in the same two steps with the same errors: the unlocked owned-root read
    // (`conversation.not_found`), then this backstop under the locks for an actor removed in
    // between (`forbidden`, the text `readContextLocked` and the managed writer throw). The
    // recorder maps both codes to its one `actor` run error: the model-facing refusal is the same
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
    const base = await this.baseScopeLocked({
      orgId: ctx.orgId,
      deviceId: ctx.deviceId,
      root,
      holderConversationId: ctx.holderConversationId,
      runId: ctx.actor.runId,
      ...opts,
    });
    const { policy, device, workingRoot, projectRoot, grant, sandbox } = base;
    const applied = await this.facts.readAppliedEnvironmentLocked({
      orgId: ctx.orgId,
      deviceId: ctx.deviceId,
    });
    // admission's hosts, as the recorded context names them: within a cloud instance's applied
    // outer boundary
    const allowedHosts = hostsWithinOuter(base.allowedHosts, applied?.outerNetwork);
    const grantHosts = hostsWithinOuter(base.grantHosts, applied?.outerNetwork);
    captureGrant?.(
      grant
        ? {
            hosts: grant.hosts.filter((host) => grantHosts.includes(host)).sort(),
            source: { ...grant.source },
          }
        : undefined,
    );
    const effectiveProfile: PermissionProfile = unattended ? "request-approval" : view.profile;
    // one verdict for local and cloud devices alike (B-16, B-15): a cloud device without an
    // instance yet is refused here, but provisioning is not an admitted operation: the lifecycle
    // lease creates the instance and records its evidence before the first operation is admitted
    const withheld = withheldScope({
      availability: view.availability,
      location: device.source === "local" ? "local" : "cloud",
      workingRoot,
      projectPath: projectRoot,
      applied,
    });
    // whether this call could run outside the sandbox (per-call escalation): the device's
    // outside-sandbox ceiling, which already holds the provider's support for it
    const escalationRefusal = unattended
      ? ESCALATION_UNATTENDED_WHY
      : withheld
        ? escalationRuntimeWhy(withheld.reason)
        : !view.outsideSandboxCeiling
          ? sandbox.layer.outsideSandbox === "provider"
            ? escalationRuntimeWhy("This device's runtime cannot run a command outside its sandbox")
            : ESCALATION_CEILING_WHY
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
      baseReadDirectories: restrictedReadRoots(workingRoot, applied),
      baseWriteDirectories: [workingRoot],
      baseHosts: allowedHosts,
      network: sandboxNetworkOf(sandbox, applied?.outerNetwork),
      boundary: sandbox.boundary,
      outsideSandboxCeiling: view.outsideSandboxCeiling,
      broadProjectReach: view.broadProjectReach,
      // the view keeps Full access only while its consent covers the device's ceilings
      fullConsent: view.profile === "full-access",
      unattended,
      // the review and admission see the recorded context's verdict, never a wider one
      availability: withheld ?? view.availability,
      admissionRefusal: withheld?.reason ?? null,
      outerNetwork: applied?.outerNetwork ?? null,
      escalationRefusal,
      // the host ceiling a per-call grant is checked against, the one rule the candidate builder,
      // grant issuance and admission read (`policy.network` is its network form: `open-public`
      // for the kernel's bounds; `hostCeiling` keeps the org's exclusions, `hostRefusal` the text)
      policy: {
        ...policy,
        network:
          base.hostCeiling.kind === "any"
            ? { kind: "open-public", hosts: [] }
            : { kind: "allowlist", hosts: [...base.hostCeiling.hosts] },
      },
      hostCeiling: base.hostCeiling,
      hostRefusal: base.hostRefusal,
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
    /** A kernel read of the bound project: its root as the working root it becomes once read. */
    projectUsable?: true;
  }) {
    const { orgId, deviceId } = input;
    const { policy, owner, sandbox, hostCeiling, hostRefusal } = await this.facts.readDevice(
      orgId,
      deviceId,
    );
    const device = await this.db
      .selectFrom("devices")
      .select("source")
      .where("id", "=", deviceId)
      .executeTakeFirstOrThrow();
    const { workingRoot, projectRoot } = await this.workingRootOf({
      ...input,
      reach: projectReachOf(device.source, policy, owner?.restrictedProjectReach),
      mode: policy.mode,
    });
    const grant = input.runId
      ? await this.grants.forExec({ orgId, deviceId, runId: input.runId })
      : undefined;
    // the run's or task's explicit host grants within the per-call ceiling: carried as the exec's
    // grants under any open network too (redundant there, so a later narrowing keeps them working)
    const grantHosts = (grant?.hosts ?? []).filter((host) => hostGrantable(hostCeiling, host));
    // the device sandbox's allowlist plus those grants; an open or closed network names no hosts
    const allowedHosts =
      sandbox.networkMode !== "allowlist" ? [] : [...new Set([...sandbox.hosts, ...grantHosts])];
    return {
      policy,
      device,
      workingRoot,
      projectRoot,
      grant,
      grantHosts,
      allowedHosts,
      sandbox,
      hostCeiling,
      hostRefusal,
    };
  }

  /**
   * The working root of the base authority (B1), decided exactly as the command review decides it
   * (`devices/working-root.ts` `workingRootOf`, permission activation L2): the bound project's
   * root when the root conversation's latest `project_root` snapshot is usable and names that
   * root, else the recorded or reported workspace. A bound project before its first snapshot, an
   * unavailable one, one outside the workspace without the os-user reach and one above the
   * owner's home all work in the workspace, so a call the review judged against the workspace is
   * not stale at admission. Narrowing only: no root other than the binding's or the workspace is
   * ever named. `projectUsable` (a kernel read of the bound project) takes the binding as its
   * snapshot. `projectRoot` is the bound project path when it is the working root, else null.
   * Admission, the recorded permission context and the managed device context evidence all
   * resolve it here, so none of them can name a wider root than admission.
   */
  private async workingRootOf(input: {
    orgId: string;
    deviceId: string;
    root: PermissionRoot;
    holderConversationId: string;
    reach: "workspace" | "os-user";
    mode: EffectiveDevicePolicy["mode"];
    projectUsable?: true;
  }): Promise<{ workingRoot: string; projectRoot: string | null }> {
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
    if (!root.project_path) return { workingRoot: working.workspace, projectRoot: null };
    const bound = root.project_path;
    const snapshot = input.projectUsable ? { root: bound, unavailable: false } : working.project;
    // a snapshot of another root than the binding (an older binding's) never names the root
    const usable =
      snapshot != null &&
      !snapshot.unavailable &&
      canonicalRoot(snapshot.root) === canonicalRoot(bound)
        ? { root: bound, unavailable: false }
        : null;
    const workingRoot = reviewWorkingRootOf(usable, {
      mode: input.mode,
      reach: input.reach,
      workspace: working.workspace,
      home: working.home,
    });
    const projectRoot =
      usable !== null && canonicalRoot(workingRoot) === canonicalRoot(bound) ? bound : null;
    return { workingRoot, projectRoot };
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
    const { policy, owner } = await this.facts.readDevice(input.orgId, input.deviceId);
    const device = await this.db
      .selectFrom("devices")
      .select("source")
      .where("id", "=", input.deviceId)
      .executeTakeFirstOrThrow();
    return (
      await this.workingRootOf({
        orgId: input.orgId,
        deviceId: input.deviceId,
        root,
        holderConversationId: input.conversationId,
        reach: projectReachOf(device.source, policy, owner?.restrictedProjectReach),
        mode: policy.mode,
      })
    ).workingRoot;
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
  ): Promise<PermissionContextV2> {
    signal.throwIfAborted();
    // a run whose trigger account is not the conversation's owner (a group-chat sender, a wake
    // attributed to another member) is not refused: its context is unavailable and it runs without
    // the device, which is never used by another account. A removed or disabled actor keeps the
    // actor refusal (B-19), and the run must be this account's run of this conversation
    let foreign = false;
    let root: PermissionRoot;
    try {
      root = await this.profiles.readOwnedRoot(input.orgId, input.conversationId, input.accountId);
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== "conversation.not_found") throw error;
      if (!(await this.isActiveMember(input.orgId, input.accountId)))
        throw new ApiError("forbidden", "This run's actor is no longer authorized");
      root = await this.profiles.readRoot(input.orgId, input.conversationId);
      await this.runScheduledLocked(input.conversationId, input.accountId, input.runId);
      foreign = true;
    }
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
      version: 2 as const,
      // only a supported context carries the device sandbox block (below)
      sandbox: null,
      rootConversationId: root.id,
      execution: scheduled ? ("scheduled" as const) : ("interactive" as const),
      inherited: input.conversationId !== root.id,
    };
    const parse = (payload: PermissionContextV2) => {
      signal.throwIfAborted();
      // every supported context this producer records carries its device sandbox block: the
      // block-less form exists only as a stored version 1 context read as version 2
      if ((payload.availability.state === "supported") !== (payload.sandbox !== null))
        throw new Error("A supported permission context must record its device sandbox");
      return PermissionContextV2Schema.parse(payload);
    };
    if (foreign && root.device_id !== null)
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
          reason: ACTOR_NOT_DEVICE_OWNER_REASON,
        },
        scope: null,
      });
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
          reason: ACTOR_DEVICE_ACCESS_REASON,
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
    // the hosts admission uses: within a cloud instance's applied outer boundary (B-15)
    const allowedHosts = hostsWithinOuter(base.allowedHosts, applied?.outerNetwork);
    // the verdict admission refuses with (B-16)
    const withheld = withheldScope({
      availability,
      location,
      workingRoot: base.workingRoot,
      projectPath: base.projectRoot,
      applied,
    });
    if (withheld) return without(withheld.state, withheld.reason);
    if (applied === null) throw new Error("A supported context needs its applied environment");
    if (effectiveProfile === "full-access" && view.consentScope?.deviceId !== deviceId)
      throw new Error("Full access lost its consent inside one authority read");
    const box = base.sandbox;
    const kind = sandboxNetworkOf(box, applied.outerNetwork);
    const hosts =
      kind === "allowlist" ? [...new Set(allowedHosts)].sort(permissionCodePointCompare) : [];
    // the same scope admission builds for every profile ({@link intersectPermissionScope})
    const network =
      kind === "open-public"
        ? ({ kind: "open-public" } as const)
        : hosts.length
          ? ({ kind: "allowlist", hosts } as const)
          : ({ kind: "none" } as const);
    const directories =
      box.boundary === "instance"
        ? instanceRoots(base.workingRoot)
        : restrictedReadRoots(base.workingRoot, applied);
    return parse({
      ...known,
      availability: { state: "supported" },
      scope: {
        location,
        workingRoot: base.workingRoot,
        filesystem: {
          kind: "scoped",
          readDirectories: directories,
          writeDirectories: box.boundary === "instance" ? directories : [base.workingRoot],
        },
        network,
        outerNetwork: applied.outerNetwork,
      },
      sandbox: {
        boundary: box.boundary,
        location,
        workingRoot: base.workingRoot,
        network: { kind: network.kind, hostsCount: hosts.length },
        // a cloud device has no outside: its provider's instance is the outermost boundary
        outsideSandbox: location === "local" && box.outsideSandbox,
        outerNetwork: applied.outerNetwork,
      },
    });
  }
}
