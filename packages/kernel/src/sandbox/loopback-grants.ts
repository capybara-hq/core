import { randomUUID } from "node:crypto";
import {
  DeviceAccessError,
  LOOPBACK_MAX_PORTS_PER_SERVICE,
  type LoopbackGrantSource,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import { ApiError } from "../errors.js";
import { audit } from "../identity/audit.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { asPlatform } from "../infra/database/org-scope.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { XactLock } from "../infra/database/xact-lock.js";
import { OutboxService } from "../infra/outbox/outbox.service.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { DeviceServices } from "./device-services.js";
import {
  endedGrants,
  isDatabasePort,
  knownLoopbackRefusal,
  LOOPBACK_GRANT_TTL_HOURS,
  type LoopbackGrantKey,
  type LoopbackGrantRow,
  LoopbackLimitError,
  type LoopbackRefreshJobData,
  loopbackRefusal,
  oweLoopbackFollowUp,
  oweRefresh,
  rowOf,
} from "./loopback-grant-records.js";
import { LoopbackLivePorts } from "./loopback-live-ports.js";
import { type PermissionAvailability, runtimeReportVerdict } from "./permission-availability.js";
import { PermissionFacts } from "./permission-facts.js";
import { escalationCeilingWhy, escalationRuntimeWhy } from "./review/permission-candidate.js";

// the constants, types and plain functions live in a leaf module (no services imported), so
// conversation deletion and ceiling writes import them without an import cycle
export * from "./loopback-grant-records.js";

/** How long an ended grant row is kept before the expiry pass deletes it (the audit log stays). */
export const LOOPBACK_ENDED_RETENTION_DAYS = 30;
/** The rows one retention batch deletes. */
export const LOOPBACK_PURGE_BATCH = 500;
/** The retention batches one expiry pass runs at most. */
export const LOOPBACK_PURGE_MAX_BATCHES = 20;

/**
 * The lock of one (device, service)'s live set (decision R9: one provider per
 * transaction-scoped lock): serializes grants of the service, so the count of its live ports
 * checked against {@link LOOPBACK_MAX_PORTS_PER_SERVICE} and the insert are one step. Joins the
 * caller's transaction (`mandatory`), which holds it until it ends.
 */
@Injectable()
export class LoopbackGrantLock {
  constructor(
    @Inject(XactLock) private readonly xactLock: XactLock,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
  ) {}

  @Transactional({ propagation: "mandatory" })
  async lock(deviceId: string, serviceId: string): Promise<void> {
    await this.xactLock.lock(`capybara.loopback-grants:${deviceId}:${serviceId}`);
  }
}

/** The grant records: issue, revoke, read, refresh and expiry (see the file header). */
@Injectable()
export class LoopbackGrants {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(LoopbackGrantLock) private readonly locks: LoopbackGrantLock,
    @Inject(LoopbackLivePorts) private readonly live: LoopbackLivePorts,
    @Inject(PermissionFacts)
    private readonly facts: Pick<PermissionFacts, "deviceSandboxFacts">,
    @Inject(DeviceServices) private readonly services: Pick<DeviceServices, "refreshLoopback">,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<KernelLogger, "warn">,
  ) {}

  /**
   * In the caller's transaction (`propagation: "mandatory"`): expires stale rows of the key,
   * inserts the grant (or returns the live row, with no second audit or refresh), audits
   * `device.loopback_granted` and owes the refresh. Throws {@link LoopbackLimitError} when the
   * port would be the service's 33rd live one. The caller checked the person, the device and the
   * ceilings ({@link loopbackRefusal}).
   */
  @Transactional({ propagation: "mandatory" })
  async grantIn(
    key: LoopbackGrantKey,
    by: {
      source: LoopbackGrantSource;
      actorAccountId: string | null;
      approvalId?: string;
      call?: { runId: string; callId: string; attempt: number };
    },
  ): Promise<LoopbackGrantRow> {
    if ((by.source === "owner-panel") !== (by.call === undefined))
      throw new Error("A loopback grant names its call unless the owner's panel made it");
    const db = this.db.db;
    // the root must be a live root conversation, read FOR SHARE: a deletion that commits first is
    // seen here (the row is re-checked after its lock), and one that comes later waits for this
    // transaction and then revokes the grant with the conversation's other grants
    const root = await db
      .selectFrom("conversations")
      .select("id")
      .where("id", "=", key.rootConversationId)
      .where("org_id", "=", key.orgId)
      .where("deleted_at", "is", null)
      .where("parent_conversation_id", "is", null)
      .forShare()
      .executeTakeFirst();
    if (!root)
      throw new ApiError(
        "conversation.not_found",
        "The conversation was deleted or is not a root conversation; a loopback port is granted to a live root conversation",
      );
    await this.locks.lock(key.deviceId, key.serviceId);
    const stale = await db
      .updateTable("device_loopback_grants")
      .set({ revoked_at: sql<Date>`now()`, revoke_reason: "expired" })
      .where("org_id", "=", key.orgId)
      .where("device_id", "=", key.deviceId)
      .where("service_id", "=", key.serviceId)
      .where("conversation_id", "=", key.rootConversationId)
      .where("port", "=", key.port)
      .where("revoked_at", "is", null)
      .where("expires_at", "<=", sql<Date>`now()`)
      .returning(["id", "org_id", "device_id", "service_id", "conversation_id", "port"])
      .execute();
    for (const r of stale)
      await audit(db, {
        actorAccountId: null,
        orgId: r.org_id,
        action: "device.loopback_revoked",
        target: r.device_id,
        detail: {
          grantId: r.id,
          deviceId: r.device_id,
          serviceId: r.service_id,
          conversationId: r.conversation_id,
          port: r.port,
          reason: "expired",
        },
      });
    const existing = await db
      .selectFrom("device_loopback_grants")
      .selectAll()
      .where("org_id", "=", key.orgId)
      .where("device_id", "=", key.deviceId)
      .where("service_id", "=", key.serviceId)
      .where("conversation_id", "=", key.rootConversationId)
      .where("port", "=", key.port)
      .where("revoked_at", "is", null)
      .executeTakeFirst();
    if (existing) return rowOf(existing);
    const ports = await this.live.livePorts(key.orgId, key.deviceId, key.serviceId);
    if (!ports.includes(key.port) && ports.length >= LOOPBACK_MAX_PORTS_PER_SERVICE)
      throw new LoopbackLimitError();
    const inserted = await db
      .insertInto("device_loopback_grants")
      .values({
        id: randomUUID(),
        org_id: key.orgId,
        device_id: key.deviceId,
        service_id: key.serviceId,
        conversation_id: key.rootConversationId,
        port: key.port,
        source: by.source,
        ...(by.approvalId !== undefined && { approval_id: by.approvalId }),
        ...(by.call !== undefined && {
          run_id: by.call.runId,
          call_id: by.call.callId,
          attempt: by.call.attempt,
        }),
        expires_at: sql<Date>`now() + make_interval(hours => ${LOOPBACK_GRANT_TTL_HOURS})`,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const row = rowOf(inserted);
    await audit(db, {
      actorAccountId: by.actorAccountId,
      orgId: key.orgId,
      action: "device.loopback_granted",
      target: key.deviceId,
      detail: {
        grantId: row.id,
        deviceId: key.deviceId,
        serviceId: key.serviceId,
        conversationId: key.rootConversationId,
        port: key.port,
        database: isDatabasePort(key.port),
        source: by.source,
        expiresAt: row.expiresAt,
        ...(by.approvalId !== undefined && { approvalId: by.approvalId }),
        ...(by.call !== undefined && { ...by.call }),
      },
    });
    await oweRefresh(
      this.outbox,
      { orgId: key.orgId, deviceId: key.deviceId, serviceId: key.serviceId },
      `g${row.id}`,
    );
    return row;
  }

  /**
   * Revokes the key's live grant (reason `revoked`, audited `device.loopback_revoked`) and owes the
   * refresh; false when there was none.
   */
  @Transactional()
  async revoke(key: LoopbackGrantKey, actorAccountId: string): Promise<boolean> {
    const rows = await this.db
      .updateTable("device_loopback_grants")
      .set({ revoked_at: sql<Date>`now()`, revoke_reason: "revoked" })
      .where("org_id", "=", key.orgId)
      .where("device_id", "=", key.deviceId)
      .where("service_id", "=", key.serviceId)
      .where("conversation_id", "=", key.rootConversationId)
      .where("port", "=", key.port)
      .where("revoked_at", "is", null)
      .returning(["id", "org_id", "device_id", "service_id", "conversation_id", "port"])
      .execute();
    await endedGrants(this.db.db, this.outbox, rows, "revoked", actorAccountId);
    return rows.length > 0;
  }

  /** The live ports of one (device, service): sorted, unique, not revoked, not expired. */
  livePorts(orgId: string, deviceId: string, serviceId: string): Promise<number[]> {
    return this.live.livePorts(orgId, deviceId, serviceId);
  }

  /**
   * In the caller's transaction (`propagation: "mandatory"`): the key's live grant read
   * `FOR SHARE`, or null. A revoke committed first is not seen; one that comes later waits for the
   * caller's transaction.
   */
  @Transactional({ propagation: "mandatory" })
  async liveLockedIn(key: LoopbackGrantKey): Promise<LoopbackGrantRow | null> {
    const row = await this.db
      .selectFrom("device_loopback_grants")
      .selectAll()
      .where("org_id", "=", key.orgId)
      .where("device_id", "=", key.deviceId)
      .where("service_id", "=", key.serviceId)
      .where("conversation_id", "=", key.rootConversationId)
      .where("port", "=", key.port)
      .where("revoked_at", "is", null)
      .where("expires_at", ">", sql<Date>`now()`)
      .forShare()
      .executeTakeFirst();
    return row === undefined ? null : rowOf(row);
  }

  /** The live grants of one (device, service) held by the root, by port. */
  async liveForRoot(
    orgId: string,
    deviceId: string,
    serviceId: string,
    rootConversationId: string,
  ): Promise<LoopbackGrantRow[]> {
    const rows = await this.db
      .selectFrom("device_loopback_grants")
      .selectAll()
      .where("org_id", "=", orgId)
      .where("device_id", "=", deviceId)
      .where("service_id", "=", serviceId)
      .where("conversation_id", "=", rootConversationId)
      .where("revoked_at", "is", null)
      .where("expires_at", ">", sql<Date>`now()`)
      .orderBy("port")
      .execute();
    return rows.map(rowOf);
  }

  /**
   * The live grant the call made (a rerun after a crash resumes from it), or null when it made
   * none or the grant ended since.
   */
  async forCall(runId: string, callId: string): Promise<LoopbackGrantRow | null> {
    // org-filter: the runtime's own run and call ids name the grant; the run was claimed under its
    // org, and run ids are unique across orgs
    const row = await this.db
      .selectFrom("device_loopback_grants")
      .selectAll()
      .where("run_id", "=", runId)
      .where("call_id", "=", callId)
      .where("revoked_at", "is", null)
      .where("expires_at", ">", sql<Date>`now()`)
      .orderBy("created_at", "desc")
      .limit(1)
      .executeTakeFirst();
    return row ? rowOf(row) : null;
  }

  /**
   * Why a loopback grant on the device is refused now for an attended decision (a person's click
   * or approval; an unattended run is refused before), in the note's words ({@link loopbackRefusal});
   * null when grantable. The escalation refusal is previewCall's for an attended call: the runtime
   * cannot run anything outside its sandbox now, else the device's outside-sandbox ceiling. Read
   * outside the grant's transaction: a ceiling switched off meanwhile owes a refresh whose job
   * revokes the grant ({@link refresh}), so the window is bounded.
   */
  async refusalNow(orgId: string, deviceId: string): Promise<string | null> {
    const facts = await this.facts.deviceSandboxFacts(orgId, deviceId);
    const runtime = runtimeWhy(facts.availability);
    const escalation =
      runtime !== null
        ? escalationRuntimeWhy(runtime)
        : facts.box.outsideSandbox
          ? null
          : escalationCeilingWhy({
              layer: facts.box.layer.outsideSandbox,
              boundary: facts.box.boundary,
              description: facts.description,
              changeHint: facts.changeHint,
            });
    return loopbackRefusal(facts.box, facts.support, escalation);
  }

  /**
   * The refresh job. First it revokes the (device, service)'s live grants (reason
   * `outside-sandbox-off`, audited) when the device refuses loopback grants now: a ceiling layer
   * keeps running outside the sandbox off, or the provider's known support lacks
   * `network.loopbackPorts` (a provider that lost it; {@link knownLoopbackRefusal}). A support
   * not known (none stored, a failed read, or a closed one with an `unavailableReason`, as while a
   * device re-binds) revokes nothing: grants are consents, and new ones are refused meanwhile.
   * Then it sends the live set to an `ifRunning` ensure of the service
   * (`DeviceServices.refreshLoopback`), always, so a revocation already recorded reaches the
   * machine whatever the support says. A stopped service or instance needs nothing: its
   * next ensure sends the set. A failed send owes a delayed follow-up
   * ({@link oweLoopbackFollowUp}), so a narrowing never stays on a machine the kernel records as
   * running because one send failed.
   */
  async refresh(data: LoopbackRefreshJobData, signal: AbortSignal): Promise<void> {
    const refused = knownLoopbackRefusal(
      await this.facts.deviceSandboxFacts(data.orgId, data.deviceId),
    );
    if (refused !== null) await this.revokeRefused(data, refused);
    signal.throwIfAborted();
    try {
      await this.services.refreshLoopback(data.orgId, data.deviceId, data.serviceId, signal);
    } catch (err) {
      // a provider without services runs none, so nothing holds a port there
      if (err instanceof DeviceAccessError && err.code === "capability_missing") return;
      const owed = await this.followUp(data);
      this.log.warn("loopback refresh failed", {
        deviceId: data.deviceId,
        serviceId: data.serviceId,
        followUp: owed ? (data.followUp ?? 0) + 1 : null,
        err,
      });
    }
  }

  @Transactional()
  private followUp(data: LoopbackRefreshJobData): Promise<boolean> {
    return oweLoopbackFollowUp(this.outbox, data);
  }

  @Transactional()
  private async revokeRefused(
    data: LoopbackRefreshJobData,
    cause: "ceiling" | "provider-support",
  ): Promise<void> {
    const rows = await this.db
      .updateTable("device_loopback_grants")
      .set({ revoked_at: sql<Date>`now()`, revoke_reason: "outside-sandbox-off" })
      .where("org_id", "=", data.orgId)
      .where("device_id", "=", data.deviceId)
      .where("service_id", "=", data.serviceId)
      .where("revoked_at", "is", null)
      .returning(["id", "org_id", "device_id", "service_id", "conversation_id", "port"])
      .execute();
    // audited only: this job is the refresh their revocation would owe
    for (const r of rows)
      await audit(this.db.db, {
        actorAccountId: null,
        orgId: r.org_id,
        action: "device.loopback_revoked",
        target: r.device_id,
        detail: {
          grantId: r.id,
          deviceId: r.device_id,
          serviceId: r.service_id,
          conversationId: r.conversation_id,
          port: r.port,
          reason: "outside-sandbox-off",
          cause,
        },
      });
  }

  /**
   * The expiry pass: marks every live grant past its `expires_at` revoked (reason `expired`,
   * audited) and owes one refresh per (device, service). Returns how many it ended. Then it
   * deletes the grant rows that ended more than {@link LOOPBACK_ENDED_RETENTION_DAYS} days ago
   * ({@link purgeEnded}; the audit log keeps every grant and its end).
   */
  async expireDue(): Promise<number> {
    const ended = await asPlatform("loopback grant expiry sweep over every org", () =>
      this.expireDueIn(),
    );
    await this.purgeEnded();
    return ended;
  }

  /**
   * Deletes ended grant rows older than the retention, in batches of
   * {@link LOOPBACK_PURGE_BATCH} (each its own transaction), at most
   * {@link LOOPBACK_PURGE_MAX_BATCHES} per pass: the next pass takes the rest. Returns how many.
   */
  async purgeEnded(): Promise<number> {
    let total = 0;
    for (let i = 0; i < LOOPBACK_PURGE_MAX_BATCHES; i++) {
      const n = await asPlatform("loopback grant retention sweep over every org", () =>
        this.purgeEndedBatch(),
      );
      total += n;
      if (n < LOOPBACK_PURGE_BATCH) break;
    }
    return total;
  }

  @Transactional()
  private async purgeEndedBatch(): Promise<number> {
    // org-filter: the retention sweep over every org's ended grants, entered under asPlatform by
    // purgeEnded; nothing live is touched
    const r = await this.db
      .deleteFrom("device_loopback_grants")
      .where(
        "id",
        "in",
        this.db
          .selectFrom("device_loopback_grants")
          .select("id")
          .where("revoked_at", "is not", null)
          .where(
            "revoked_at",
            "<",
            sql<Date>`now() - make_interval(days => ${LOOPBACK_ENDED_RETENTION_DAYS})`,
          )
          .limit(LOOPBACK_PURGE_BATCH),
      )
      .executeTakeFirst();
    return Number(r.numDeletedRows);
  }

  @Transactional()
  private async expireDueIn(): Promise<number> {
    // org-filter: the expiry sweep over every org's grants, entered under asPlatform by
    // expireDue; each row keeps its org
    const rows = await this.db
      .updateTable("device_loopback_grants")
      .set({ revoked_at: sql<Date>`now()`, revoke_reason: "expired" })
      .where("revoked_at", "is", null)
      .where("expires_at", "<=", sql<Date>`now()`)
      .returning(["id", "org_id", "device_id", "service_id", "conversation_id", "port"])
      .execute();
    await endedGrants(this.db.db, this.outbox, rows, "expired", null);
    return rows.length;
  }
}

/** Why the device's runtime cannot run anything outside its sandbox now; null when it can. */
function runtimeWhy(availability: PermissionAvailability): string | null {
  if (availability.state === "unsupported") return availability.reason;
  if (availability.state === "supported") return runtimeReportVerdict(availability.report);
  return null;
}
