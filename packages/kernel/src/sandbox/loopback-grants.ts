import { randomUUID } from "node:crypto";
import {
  DeviceAccessError,
  LOOPBACK_MAX_PORTS_PER_SERVICE,
  type LoopbackGrantSource,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import { audit } from "../identity/audit.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { asPlatform } from "../infra/database/org-scope.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { XactLock } from "../infra/database/xact-lock.js";
import { OutboxService } from "../infra/outbox/outbox.service.js";
import { DeviceServices } from "./device-services.js";
import {
  endedGrants,
  isDatabasePort,
  LOOPBACK_GRANT_TTL_HOURS,
  type LoopbackGrantKey,
  type LoopbackGrantRow,
  LoopbackLimitError,
  type LoopbackRefreshJobData,
  loopbackRefusal,
  oweRefresh,
  rowOf,
} from "./loopback-grant-records.js";
import { LoopbackLivePorts } from "./loopback-live-ports.js";
import { PermissionFacts } from "./permission-facts.js";

// the constants, types and plain functions live in a leaf module (no services imported), so
// conversation deletion and ceiling writes import them without an import cycle
export * from "./loopback-grant-records.js";

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
    await this.locks.lock(key.deviceId, key.serviceId);
    const db = this.db.db;
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
   * The refresh job: revokes the (device, service)'s live grants (reason `outside-sandbox-off`,
   * audited) when the device refuses loopback grants now ({@link loopbackRefusal}: a ceiling
   * switched off, a provider that lost its support), then sends the live set to an `ifRunning`
   * ensure of the service (`DeviceServices.refreshLoopback`; a stopped service or instance needs
   * nothing: its next ensure sends the set).
   */
  async refresh(data: LoopbackRefreshJobData, signal: AbortSignal): Promise<void> {
    const facts = await this.facts.deviceSandboxFacts(data.orgId, data.deviceId);
    // no run here: only the device's ceiling decides whether a call could run outside now
    const escalation = facts.box.outsideSandbox ? null : "the outside-sandbox setting is off";
    if (loopbackRefusal(facts.box, facts.support, escalation) !== null)
      await this.revokeRefused(data);
    signal.throwIfAborted();
    try {
      await this.services.refreshLoopback(data.orgId, data.deviceId, data.serviceId, signal);
    } catch (err) {
      // a provider without services runs none, so nothing holds a port there
      if (err instanceof DeviceAccessError && err.code === "capability_missing") return;
      throw err;
    }
  }

  @Transactional()
  private async revokeRefused(data: LoopbackRefreshJobData): Promise<void> {
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
        },
      });
  }

  /**
   * The expiry pass: marks every live grant past its `expires_at` revoked (reason `expired`,
   * audited) and owes one refresh per (device, service). Returns how many it ended.
   */
  expireDue(): Promise<number> {
    return asPlatform("loopback grant expiry sweep over every org", () => this.expireDueIn());
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
