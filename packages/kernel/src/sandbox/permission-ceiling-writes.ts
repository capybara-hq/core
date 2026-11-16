import type { SandboxBrowseScope, SandboxOperationScope } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import type { Selectable } from "kysely";
import type { SandboxOperationIntentsTable } from "../db/kernel-schema.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { OutboxService } from "../infra/outbox/outbox.service.js";
import { PermissionAuthorityEpochStore } from "./permission-authority-epochs.js";
import { type AuthoritySubject, PermissionAuthorityLock } from "./permission-authority-lock.js";

const required = <T>(value: T | null | undefined): T => {
  if (value === undefined || value === null) throw new Error("The authority subject is incomplete");
  return value;
};
/** Lower-level publication shared by ceiling writers; imports no facts, profiles or lifecycle. */
@Injectable()
export class PermissionCeilingWrites {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(PermissionAuthorityLock) private readonly locks: PermissionAuthorityLock,
    @Inject(PermissionAuthorityEpochStore) private readonly epochs: PermissionAuthorityEpochStore,
    @Inject(OutboxService) private readonly outbox: OutboxService,
  ) {}
  @Transactional({ propagation: "mandatory" })
  async lock(
    subject: AuthoritySubject,
    level: "platform" | "org" | "device" | "root",
  ): Promise<void> {
    await this.locks.acquire(subject, { kind: "write", level });
  }
  /** The platform writer excludes every descendant; only these environments changed Full reach. */
  @Transactional({ propagation: "mandatory" })
  async invalidateDeviceConsentUnderPlatform(deviceIds: readonly string[]): Promise<void> {
    this.locks.assertHeld("platform", "platform", true);
    for (const id of deviceIds)
      await this.db
        .insertInto("permission_authority_epochs")
        .values({ kind: "device", id, full_revision: 1 })
        .onConflict((oc) =>
          oc.columns(["kind", "id"]).doUpdateSet((eb) => ({
            full_revision: eb("permission_authority_epochs.full_revision", "+", 1),
          })),
        )
        .execute();
    if (deviceIds.length)
      await this.db
        .updateTable("conversations")
        .set((eb) => ({
          permission_profile: "approve-for-me",
          permission_consent: null,
          permission_revision: eb("permission_revision", "+", 1),
        }))
        .where("device_id", "in", [...deviceIds])
        .where("permission_profile", "=", "full-access")
        .execute();
  }
  @Transactional({ propagation: "mandatory" })
  async publishLocked(
    subject: AuthoritySubject,
    level: "platform" | "org" | "device" | "root",
    revoke:
      | boolean
      | ((
          scope: SandboxOperationScope | SandboxBrowseScope,
          row: Selectable<SandboxOperationIntentsTable>,
        ) => boolean) = true,
    invalidateFullConsent = false,
  ): Promise<void> {
    const id =
      level === "platform"
        ? "platform"
        : level === "org"
          ? subject.orgId
          : level === "device"
            ? subject.deviceId
            : subject.rootConversationId;
    if (!id) throw new Error("Ceiling publication requires its actual subject");
    this.locks.assertHeld(level, id, true);
    const vector = await this.epochs.readLocked(subject);
    await this.epochs.bumpLocked(level, id, required(vector[level]));
    if (invalidateFullConsent) {
      await this.db
        .updateTable("permission_authority_epochs")
        .set((eb) => ({ full_revision: eb("full_revision", "+", 1) }))
        .where("kind", "=", level)
        .where("id", "=", id)
        .execute();
      let roots = this.db
        .updateTable("conversations")
        .set((eb) => ({
          permission_profile: "approve-for-me",
          permission_consent: null,
          permission_revision: eb("permission_revision", "+", 1),
        }))
        .where("permission_profile", "=", "full-access");
      if (level !== "platform") roots = roots.where("org_id", "=", required(subject.orgId));
      if (level === "device") roots = roots.where("device_id", "=", required(subject.deviceId));
      if (level === "root") roots = roots.where("id", "=", required(subject.rootConversationId));
      await roots.execute();
    }
    if (!revoke) return;
    let candidates = this.db
      .selectFrom("sandbox_operation_intents")
      .selectAll()
      .where("state", "in", ["admitted", "dispatching", "started-or-unknown"]);
    if (level !== "platform") candidates = candidates.where("org_id", "=", required(subject.orgId));
    if (level === "device")
      candidates = candidates.where("device_id", "=", required(subject.deviceId));
    if (level === "root")
      candidates = candidates.where(
        "root_conversation_id",
        "=",
        required(subject.rootConversationId),
      );
    for (const row of await candidates.forUpdate().execute()) {
      if (typeof revoke === "function" && !revoke(row.scope, row)) continue;
      await this.db
        .updateTable("sandbox_operation_intents")
        .set({
          state: "revoked",
          outcome_unknown: row.state !== "admitted",
          updated_at: new Date(),
        })
        .where("operation_id", "=", row.operation_id)
        .execute();
      await this.outbox.add({
        queue: "cap-kernel-maintenance",
        name: "sandbox-operation-revoke",
        jobId: `sandbox-operation-revoke-${row.operation_id}`,
        data: { operationId: row.operation_id },
      });
    }
  }
}
/** Full and owner browsing outside the restricted workspace require the independent Full ceiling. */
export const needsFullCeiling = (scope: SandboxOperationScope | SandboxBrowseScope): boolean =>
  "profile" in scope ? scope.profile === "full-access" : scope.readRoots.includes("/");
