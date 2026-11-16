import { randomUUID } from "node:crypto";
import {
  type PermissionProfile,
  parseSandboxOperationScope,
  type SandboxActor,
  type SandboxOperationScope,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import {
  PermissionProfilesService,
  permissionScopeHash,
} from "../conversations/permission-profiles.service.js";
import { ConversationDevices } from "../devices/conversation-devices.js";
import { DeviceProjectsService } from "../devices/device-projects.service.js";
import { ApiError } from "../errors.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { NetworkGrants } from "../local-devices/network-grants.js";
import { localPolicyOf } from "../local-devices/policy-summary.js";
import { coversHost } from "./modes.js";
import { PermissionAuthorityEpochStore } from "./permission-authority-epochs.js";
import { PermissionAuthorityLock } from "./permission-authority-lock.js";
import { SandboxService, type SandboxUseContext } from "./sandbox.service.js";
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
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(PermissionProfilesService) private readonly profiles: PermissionProfilesService,
    @Inject(ConversationDevices) private readonly devices: ConversationDevices,
    @Inject(DeviceProjectsService) private readonly projects: DeviceProjectsService,
    @Inject(SandboxService) private readonly sandbox: SandboxService,
    @Inject(NetworkGrants) private readonly grants: NetworkGrants,
    @Inject(PermissionAuthorityLock) private readonly locks: PermissionAuthorityLock,
    @Inject(PermissionAuthorityEpochStore) private readonly epochs: PermissionAuthorityEpochStore,
  ) {}
  @Transactional()
  async resolve(
    ctx: SandboxUseContext,
    operation: SandboxAuthorityOperation,
    signal: AbortSignal,
  ): Promise<SandboxOperationScope> {
    signal.throwIfAborted();
    if (
      !["exec", "readFile", "writeFile", "stat", "list", "scan", "backgroundStart"].includes(
        operation,
      )
    )
      throw new ApiError("forbidden", "Unknown sandbox operation");
    if (ctx.actor.conversationId !== ctx.holderConversationId)
      throw new ApiError("forbidden", "Operation actor does not match its conversation");
    const initial = await this.profiles.get(
      ctx.orgId,
      ctx.holderConversationId,
      ctx.actor.accountId,
    );
    const subject = {
      orgId: ctx.orgId,
      deviceId: ctx.deviceId,
      rootConversationId: initial.rootConversationId,
    };
    await this.locks.acquire(subject, { kind: "admit" });
    const view = await this.profiles.get(ctx.orgId, ctx.holderConversationId, ctx.actor.accountId);
    if (view.deviceId !== ctx.deviceId)
      throw new ApiError("device.not_found", "The conversation is not bound to this device");
    const root = await this.db
      .selectFrom("conversations")
      .select(["scheduled_task_id", "project_name", "project_path"])
      .where("id", "=", view.rootConversationId)
      .where("org_id", "=", ctx.orgId)
      .executeTakeFirstOrThrow();
    await this.profiles.preview(
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
    const policy = await this.sandbox.devicePolicy(ctx);
    const working = await this.devices.workingFacts(
      ctx.orgId,
      view.rootConversationId,
      ctx.holderConversationId,
      ctx.deviceId,
    );
    if (
      root.project_name &&
      root.project_path &&
      !(await this.projects.keeps(ctx.deviceId, root.project_name, root.project_path))
    )
      throw new ApiError("conflict", "The conversation project binding changed");
    const workingRoot = root.project_path ?? working.workspace;
    const machine = await this.db
      .selectFrom("device_machines")
      .select("local_policy")
      .where("device_id", "=", ctx.deviceId)
      .where("org_id", "=", ctx.orgId)
      .where("revoked_at", "is", null)
      .executeTakeFirst();
    const owner = machine ? localPolicyOf(machine.local_policy) : null;
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
        policy.localAllowedDomains.some((pattern) => coversHost(pattern, host)) &&
        (policy.network.kind === "open-public" ||
          policy.network.hosts.some((pattern) => coversHost(pattern, host))),
    );
    const vector = await this.epochs.readLocked(subject);
    signal.throwIfAborted();
    const operationId = randomUUID();
    return intersectPermissionScope({
      operationId,
      admitBeforeMs: Date.now() + 30_000,
      deviceId: ctx.deviceId,
      rootConversationId: view.rootConversationId,
      profileRevision: view.revision,
      ceilingRevision: permissionScopeHash({ scopeRevision: view.scopeRevision, vector }),
      profile: unattended ? "request-approval" : view.profile,
      actor: ctx.actor,
      tag: operationId,
      workingRoot,
      readRoots: [workingRoot],
      writeRoots: [workingRoot],
      allowedHosts,
      fullAccessCeiling: view.fullAccessCeiling,
      fullConsent:
        view.profile === "full-access" && view.consentScope?.scopeRevision === view.scopeRevision,
    });
  }
}
