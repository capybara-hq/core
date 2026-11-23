import type { SandboxBrowseScope, SandboxOperationScope } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import type { Selectable } from "kysely";
import type { KernelSchemaDb, SandboxOperationIntentsTable } from "../db/kernel-schema.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { OutboxService } from "../infra/outbox/outbox.service.js";
import { coversHost } from "./modes.js";
import {
  isExecutionMethod,
  isFullExecutionScope,
  usesOpenNetwork,
} from "./operation-authority-types.js";
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
      // org-filter: platform-level writer under the exclusive platform lock: the devices whose
      // Full reach changed may lie in any org, each root is reset in its own org
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
    // Acknowledged background starts stay revocable by every actual revoking writer (deletion is
    // the root-level one). Profile changes never reach here: they only bump the root epoch.
    let candidates = this.db
      .selectFrom("sandbox_operation_intents")
      .selectAll()
      .where("state", "in", [
        "admitted",
        "dispatching",
        "started-or-unknown",
        "background-running",
      ]);
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
        .where("org_id", "=", row.org_id)
        .execute();
      if (row.state === "background-running")
        await this.db
          .updateTable("background_tasks")
          .set({ launch_state: "cancel-pending", cancel_requested_at: new Date() })
          .where("operation_id", "=", row.operation_id)
          .where("org_id", "=", row.org_id)
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
      .where("org_id", "=", root.org_id)
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
/**
 * The narrowings a ceiling write publishes (approval-only profiles design, "Ceiling writes"), each
 * bumping its epoch and revoking, in the same transaction, the admitted or started work it takes:
 * - `outside-sandbox-off`: escalated work ({@link needsFullCeiling});
 * - `network-allowlist`: work on the open public network ({@link needsOpenNetwork});
 * - `hosts-removed`: allowlist work naming a host the new list no longer covers (the writer's own
 *   host check, which keeps hosts an independent grant still holds).
 * Widening any of them resets Full consent instead (`invalidateFullConsent`); a profile change
 * alone never revokes started work.
 */
export type CeilingNarrowing = "outside-sandbox-off" | "network-allowlist" | "hosts-removed";

/** Work on the open public network: what a network ceiling narrowed to `allowlist` takes away. */
export const needsOpenNetwork = (scope: SandboxOperationScope | SandboxBrowseScope): boolean =>
  usesOpenNetwork(scope);

/** Running outside the sandbox: an escalated call (`outside-sandbox-off` takes it). */
export const requiresFullExecution = (scope: SandboxOperationScope | SandboxBrowseScope): boolean =>
  isFullExecutionScope(scope);
/**
 * What a platform or org outside-sandbox ceiling turning off takes away: escalated work (what a
 * sandboxed operation reaches is its provider's rule, which no kernel ceiling widens).
 */
export const needsFullCeiling = (scope: SandboxOperationScope | SandboxBrowseScope): boolean =>
  requiresFullExecution(scope);

/**
 * The devices that follow their org's network default (no network choice of their own and no B1
 * allowlist snapshot), with their org, whatever their provider: what narrowing a default
 * (`devices.network.default` or an org's `deviceNetwork.default`, open to allowlist) moves to the
 * allowlist, so their running open-network work is revoked.
 */
export async function devicesFollowingDefault(
  db: KernelSchemaDb,
  orgId?: string,
): Promise<Map<string, string>> {
  let q = db
    .selectFrom("devices")
    .select(["id", "org_id", "outer_network"])
    .where("network_mode", "is", null)
    .where("deleted_at", "is", null);
  if (orgId !== undefined) q = q.where("org_id", "=", orgId);
  const rows = await q.execute();
  return new Map(
    rows
      .filter((r) => (r.outer_network as { kind?: unknown } | null)?.kind !== "allowlist")
      .map((r) => [r.id, r.org_id]),
  );
}

/**
 * Whether an allowlist execution names a host the new ceilings no longer allow (`hosts-removed`):
 * a host neither in the org's effective hosts nor held by an independent run or task grant the new
 * per-call ceiling still allows (`grantable`). Native methods and other networks reach no host.
 */
export function hostsNarrowed(
  scope: SandboxOperationScope | SandboxBrowseScope,
  row: Pick<Selectable<SandboxOperationIntentsTable>, "method" | "granted_hosts">,
  orgHosts: readonly string[],
  grantable: (host: string) => boolean,
): boolean {
  if (!("network" in scope) || !isExecutionMethod(row.method) || scope.network.kind !== "allowlist")
    return false;
  return scope.network.hosts.some(
    (host) =>
      !orgHosts.some((pattern) => coversHost(pattern.toLowerCase(), host.toLowerCase())) &&
      !(row.granted_hosts.includes(host) && grantable(host)),
  );
}
