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
import { PermissionTransitions } from "./permission-transitions.js";

const required = <T>(value: T | null | undefined): T => {
  if (value === undefined || value === null) throw new Error("The authority subject is incomplete");
  return value;
};
/** Lower-level publication shared by ceiling writers; imports no facts, profiles or lifecycle. */
@Injectable()
export class PermissionCeilingWrites {
  constructor(
    @Inject(PermissionTransitions) private readonly transitions: PermissionTransitions,
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
    if (deviceIds.length) {
      const roots = await this.db
        .selectFrom("conversations")
        .selectAll()
        .where("device_id", "in", [...deviceIds])
        .where("parent_conversation_id", "is", null)
        .where("permission_profile", "=", "full-access")
        .orderBy("org_id")
        .orderBy("id")
        .forUpdate()
        .execute();
      for (const root of roots) await this.resetRoot(root, {}, "platform");
    }
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
        .selectFrom("conversations")
        .selectAll()
        .where("parent_conversation_id", "is", null)
        .where("permission_profile", "=", "full-access");
      if (level !== "platform") roots = roots.where("org_id", "=", required(subject.orgId));
      if (level === "device") roots = roots.where("device_id", "=", required(subject.deviceId));
      if (level === "root") roots = roots.where("id", "=", required(subject.rootConversationId));
      for (const root of await roots.orderBy("org_id").orderBy("id").forUpdate().execute())
        await this.resetRoot(root, subject, level);
    }
    if (!revoke) return;
    // Acknowledged background starts stay revocable by actual ceilings; a profile-only (root)
    // change leaves a started task's starting authority unchanged.
    let candidates = this.db
      .selectFrom("sandbox_operation_intents")
      .selectAll()
      .where(
        "state",
        "in",
        level === "root"
          ? ["admitted", "dispatching", "started-or-unknown"]
          : ["admitted", "dispatching", "started-or-unknown", "background-running"],
      );
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
      if (row.state === "background-running")
        await this.db
          .updateTable("background_tasks")
          .set({ launch_state: "cancel-pending", cancel_requested_at: new Date() })
          .where("operation_id", "=", row.operation_id)
          .where("launch_state", "=", "acknowledged")
          .execute();
      await this.outbox.add({
        queue: "cap-kernel-maintenance",
        name: "sandbox-operation-revoke",
        jobId: `sandbox-operation-revoke-${row.operation_id}`,
        data: { operationId: row.operation_id },
      });
    }
  }
  private async resetRoot(
    root: Selectable<import("../db/kernel-schema.js").ConversationsTable>,
    subject: AuthoritySubject,
    level: "platform" | "org" | "device" | "root",
  ): Promise<void> {
    const revision = root.permission_revision + 1;
    await this.db
      .updateTable("conversations")
      .set({
        permission_profile: "approve-for-me",
        permission_consent: null,
        permission_revision: revision,
      })
      .where("id", "=", root.id)
      .execute();
    await this.transitions.recordLocked(
      {
        orgId: root.org_id,
        rootConversationId: root.id,
        deviceId: root.device_id,
        oldProfile: "full-access",
        newProfile: "approve-for-me",
        revision,
        scopeRevision: null,
        actorAccountId: null,
        reason: "authority-changed",
      },
      { subject, level },
    );
  }
}
/** Full and owner browsing outside the restricted workspace require the independent Full ceiling. */
export const needsFullCeiling = (scope: SandboxOperationScope | SandboxBrowseScope): boolean =>
  "profile" in scope ? scope.profile === "full-access" : scope.readRoots.includes("/");
