import { createHash } from "node:crypto";
import type { PermissionProfile } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { DeviceAccess } from "../devices/access.js";
import { DeviceProjectsService } from "../devices/device-projects.service.js";
import { ApiError } from "../errors.js";
import { audit } from "../identity/audit.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { PermissionAuthorityEpochStore } from "../sandbox/permission-authority-epochs.js";
import { PermissionAuthorityLock } from "../sandbox/permission-authority-lock.js";
import { permissionAvailabilityFor } from "../sandbox/permission-availability.js";
import { providerForDevice, SandboxProviders } from "../sandbox/providers.js";
import { SandboxService } from "../sandbox/sandbox.service.js";
import { ConversationAccess } from "./access.js";
import { EventLog } from "./event-log.js";
import type { ConversationEvent } from "./events.js";
import type { PermissionSelection } from "./permission-profiles.schemas.js";
export const permissionScopeHash = (value: unknown): string =>
  createHash("sha256").update(canonical(value)).digest("hex");
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
const notice =
  "Changes apply to new operations. Work already started keeps its starting permissions.";
@Injectable()
export class PermissionProfilesService {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(ConversationAccess) private readonly access: ConversationAccess,
    @Inject(DeviceAccess) private readonly devices: DeviceAccess,
    @Inject(DeviceProjectsService) private readonly projects: DeviceProjectsService,
    @Inject(SandboxService) private readonly sandbox: SandboxService,
    @Inject(SandboxProviders) private readonly providers: SandboxProviders,
    @Inject(PermissionAuthorityLock) private readonly locks: PermissionAuthorityLock,
    @Inject(PermissionAuthorityEpochStore) private readonly epochs: PermissionAuthorityEpochStore,
    @Inject(EventLog) private readonly events: EventLog,
  ) {}
  async preview(orgId: string, accountId: string, deviceId: string, project?: string) {
    await this.devices.usable(orgId, accountId, deviceId);
    const binding =
      project === undefined
        ? null
        : await this.projects.resolveForBinding(orgId, deviceId, accountId, project);
    return this.scope(orgId, deviceId, binding?.path ?? null, project ?? null);
  }
  private async scope(
    orgId: string,
    deviceId: string,
    projectPath: string | null,
    project: string | null,
  ) {
    const policy = await this.sandbox.devicePolicy({ orgId, deviceId });
    const device = await this.db
      .selectFrom("devices")
      .select("provider")
      .where("id", "=", deviceId)
      .where("org_id", "=", orgId)
      .executeTakeFirst();
    const availability = permissionAvailabilityFor(
      device ? providerForDevice(this.providers, device.provider)?.impl : undefined,
    );
    // A ceiling restored to the same values is still a new authorization decision. Reads do
    // not initialize epoch rows; absent rows denote the pre-change revision zero.
    const epochRows = await this.db
      .selectFrom("permission_authority_epochs")
      .select(["kind", "id", "revision"])
      .where((eb) =>
        eb.or([
          eb.and([eb("kind", "=", "platform"), eb("id", "=", "platform")]),
          eb.and([eb("kind", "=", "org"), eb("id", "=", orgId)]),
          eb.and([eb("kind", "=", "device"), eb("id", "=", deviceId)]),
        ]),
      )
      .execute();
    const authority = { platform: 0, org: 0, device: 0 };
    for (const row of epochRows)
      if (row.kind === "platform" || row.kind === "org" || row.kind === "device")
        authority[row.kind] = row.revision;
    const scopeRevision = permissionScopeHash({
      authority,
      deviceId,
      projectPath,
      mode: policy.mode,
      allowedMode: policy.allowedMode,
      network: { ...policy.network, hosts: [...policy.network.hosts].sort() },
      localAllowedDomains: [...policy.localAllowedDomains].sort(),
    });
    return {
      deviceId,
      project,
      scopeRevision,
      availability,
      fullAccessCeiling: policy.mode === "auto" && policy.allowedMode === "auto",
    };
  }
  private async own(orgId: string, id: string, accountId: string) {
    if (!(await this.access.isAccessible(orgId, id, accountId)))
      throw new ApiError("conversation.not_found", "Conversation not found");
    return this.db
      .selectFrom("conversations")
      .selectAll()
      .where("id", "=", id)
      .where("org_id", "=", orgId)
      .executeTakeFirstOrThrow();
  }
  async get(orgId: string, id: string, accountId: string) {
    let row = await this.own(orgId, id, accountId);
    for (let depth = 0; row.parent_conversation_id && depth < 16; depth++)
      row = await this.own(orgId, row.parent_conversation_id, accountId);
    if (row.parent_conversation_id)
      throw new ApiError("conversation.not_found", "Conversation root not found");
    let preview: Awaited<ReturnType<PermissionProfilesService["scope"]>> | null = null;
    let unavailableReason = "Choose a device to run device operations";
    if (row.device_id) {
      try {
        await this.devices.usable(orgId, accountId, row.device_id);
        preview = await this.scope(orgId, row.device_id, row.project_path, row.project_name);
      } catch (error) {
        if (
          !(error instanceof ApiError) ||
          !["device.not_found", "device.unavailable"].includes(error.code)
        )
          throw error;
        unavailableReason = error.message;
      }
    }
    const consent = row.permission_consent as { deviceId: string; scopeRevision: string } | null;
    const profile: PermissionProfile =
      row.permission_profile === "full-access" &&
      (!preview?.fullAccessCeiling ||
        preview.availability.state === "unsupported" ||
        consent?.deviceId !== row.device_id ||
        consent?.scopeRevision !== preview.scopeRevision)
        ? "approve-for-me"
        : row.permission_profile;
    return {
      profile,
      revision: row.permission_revision,
      rootConversationId: row.id,
      deviceId: row.device_id,
      consentScope: profile === "full-access" ? consent : null,
      scopeRevision: preview?.scopeRevision ?? null,
      availability: preview?.availability ?? {
        state: "unsupported" as const,
        reason: unavailableReason,
      },
      fullAccessCeiling: preview?.fullAccessCeiling ?? false,
      startingWorkNotice: notice,
    };
  }
  /** Reserve the root ID and authority before resolving its project or inserting first-send state. */
  @Transactional({ propagation: "mandatory" })
  async lockInitial(orgId: string, id: string, deviceId: string | null): Promise<void> {
    const subject = { orgId, rootConversationId: id, ...(deviceId ? { deviceId } : {}) };
    await this.locks.acquire(subject, { kind: "write", level: "root" });
    await this.epochs.readLocked(subject);
  }
  @Transactional({ propagation: "mandatory" })
  async initialize(
    orgId: string,
    id: string,
    accountId: string,
    deviceId: string | null,
    projectPath: string | null,
    project: string | null,
    selection: PermissionSelection,
  ): Promise<ConversationEvent[]> {
    const subject = { orgId, rootConversationId: id, ...(deviceId ? { deviceId } : {}) };
    await this.locks.acquire(subject, { kind: "write", level: "root" });
    await this.epochs.readLocked(subject);
    const consent = await this.consent(orgId, accountId, deviceId, projectPath, project, selection);
    await this.db
      .updateTable("conversations")
      .set({
        permission_profile: selection.profile,
        permission_consent: consent ? JSON.stringify(consent) : null,
      })
      .where("id", "=", id)
      .where("org_id", "=", orgId)
      .execute();
    const detail = {
      oldProfile: "approve-for-me" as const,
      newProfile: selection.profile,
      actorAccountId: accountId,
      deviceId,
      scopeRevision: consent?.scopeRevision ?? null,
      revision: 0,
    };
    await audit(this.db.db, {
      orgId,
      actorAccountId: accountId,
      action: "conversation.permission_profile_changed",
      target: id,
      detail,
    });
    return this.events.appendIn(id, [{ type: "permission_profile_changed", payload: detail }]);
  }
  private async consent(
    orgId: string,
    accountId: string,
    deviceId: string | null,
    projectPath: string | null,
    project: string | null,
    selection: PermissionSelection,
  ) {
    if (deviceId) await this.devices.usable(orgId, accountId, deviceId);
    if (selection.profile !== "full-access") return null;
    if (!deviceId || !selection.consentScopeRevision)
      throw new ApiError(
        "conflict",
        "Full access requires an explicitly selected device and displayed scope consent",
      );
    const preview = await this.scope(orgId, deviceId, projectPath, project);
    if (
      !preview.fullAccessCeiling ||
      preview.availability.state === "unsupported" ||
      preview.scopeRevision !== selection.consentScopeRevision
    )
      throw new ApiError(
        "conflict",
        "Device authority changed or Full access is unavailable; refresh the permission preview",
      );
    return { deviceId, scopeRevision: preview.scopeRevision };
  }
  @Transactional()
  async set(
    orgId: string,
    id: string,
    accountId: string,
    body: PermissionSelection & { expectedRevision: number },
  ) {
    let row = await this.own(orgId, id, accountId);
    if (row.parent_conversation_id || row.kind !== "chat" || row.scheduled_task_id)
      throw new ApiError(
        "forbidden",
        "Only interactive root conversations have editable permissions",
      );
    const binding = {
      deviceId: row.device_id,
      projectName: row.project_name,
      projectPath: row.project_path,
    };
    const subject = {
      orgId,
      rootConversationId: id,
      ...(binding.deviceId ? { deviceId: binding.deviceId } : {}),
    };
    await this.locks.acquire(subject, { kind: "write", level: "root" });
    row = await this.own(orgId, id, accountId);
    // A binding writer may have won before root-write. Retry from a fresh subject instead of
    // validating another device under the old locks or acquiring a device lock after the root.
    if (
      row.device_id !== binding.deviceId ||
      row.project_name !== binding.projectName ||
      row.project_path !== binding.projectPath
    )
      throw new ApiError("conflict", "The conversation binding changed; refresh and retry");
    if (row.permission_revision !== body.expectedRevision)
      throw new ApiError("conflict", "Permissions changed; refresh and retry");
    const consent = await this.consent(
      orgId,
      accountId,
      row.device_id,
      row.project_path,
      row.project_name,
      body,
    );
    const epochs = await this.epochs.readLocked(subject);
    await this.epochs.bumpLocked("root", id, epochs.root ?? 0);
    const revision = row.permission_revision + 1;
    await this.db
      .updateTable("conversations")
      .set({
        permission_profile: body.profile,
        permission_revision: revision,
        permission_consent: consent ? JSON.stringify(consent) : null,
      })
      .where("id", "=", id)
      .execute();
    const detail = {
      oldProfile: row.permission_profile,
      newProfile: body.profile,
      actorAccountId: accountId,
      deviceId: row.device_id,
      scopeRevision: consent?.scopeRevision ?? null,
      revision,
    };
    await this.events.appendIn(id, [{ type: "permission_profile_changed", payload: detail }]);
    await audit(this.db.db, {
      orgId,
      actorAccountId: accountId,
      action: "conversation.permission_profile_changed",
      target: id,
      detail,
    });
    return { revision };
  }
}
