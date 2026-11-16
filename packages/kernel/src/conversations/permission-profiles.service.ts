import { Inject, Injectable } from "@nestjs/common";
import { DeviceAccess } from "../devices/access.js";
import { ApiError } from "../errors.js";
import { audit } from "../identity/audit.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { PermissionAuthorityEpochStore } from "../sandbox/permission-authority-epochs.js";
import { PermissionAuthorityLock } from "../sandbox/permission-authority-lock.js";
import { PermissionFacts } from "../sandbox/permission-facts.js";
import { EventLog } from "./event-log.js";
import type { ConversationEvent } from "./events.js";
import { PermissionProfileStore } from "./permission-profile-store.js";
import type { PermissionSelection } from "./permission-profiles.schemas.js";
@Injectable()
export class PermissionProfilesService {
  constructor(
    @Inject(PermissionFacts) private readonly facts: PermissionFacts,
    @Inject(PermissionProfileStore) private readonly store: PermissionProfileStore,
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(DeviceAccess) private readonly devices: DeviceAccess,
    @Inject(PermissionAuthorityLock) private readonly locks: PermissionAuthorityLock,
    @Inject(PermissionAuthorityEpochStore) private readonly epochs: PermissionAuthorityEpochStore,
    @Inject(EventLog) private readonly events: EventLog,
  ) {}
  preview(orgId: string, accountId: string, deviceId: string, project?: string) {
    return this.facts.preview(orgId, accountId, deviceId, project);
  }
  async get(orgId: string, id: string, accountId: string) {
    return this.facts.view(orgId, accountId, await this.store.readOwnedRoot(orgId, id, accountId));
  }
  /** Reserve the root ID and authority before resolving its project or inserting first-send state. */
  @Transactional({ propagation: "mandatory" })
  async lockInitial(orgId: string, id: string, deviceId: string | null): Promise<void> {
    const subject = { orgId, rootConversationId: id, ...(deviceId ? { deviceId } : {}) };
    await this.locks.acquire(subject, { kind: "write", level: "root" });
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
    const preview = await this.facts.scope(orgId, deviceId, projectPath, project);
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
    let row = await this.store.own(orgId, id, accountId);
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
    row = await this.store.own(orgId, id, accountId);
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
