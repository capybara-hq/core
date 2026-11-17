import { type DeviceOwnerCeilingV3, parseOwnerCeilingReportV3 } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { audit } from "../identity/audit.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { PermissionCeilingWrites } from "../sandbox/permission-ceiling-writes.js";
import {
  decideOwnerReport,
  machineRootList,
  type OwnerReportVia,
  ownerFactsOf,
  ownerFactsOfReport,
  ownerReportRevokes,
  type StoredOwnerReport,
  storedOwnerReportOf,
} from "./owner-report.js";

/** What became of an arrived owner report. */
export type OwnerReportOutcome = "recorded" | "same" | "stale" | "conflict" | "revoked";

/**
 * The single writer of authenticated owner reports (permission runtime cutover B2). Every carrier
 * (v3 hello, `policy` frame, policy answer or applied status, bind answer) enters here under the
 * device authority writer, for the machine the authenticated connection belongs to: a caller never
 * names another device. A higher sequence is recorded and publishes the changed effective facts
 * through the common ceiling writer: Full consent resets only when the owner's Full permission
 * (or the machine's roots) actually changed; restricted-only changes revoke only the restricted
 * work they narrow. The same report again only refreshes when it was seen; a stale or conflicting
 * one blocks new authority until a valid current report arrives.
 */
@Injectable()
export class OwnerReports {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(PermissionCeilingWrites) private readonly ceilings: PermissionCeilingWrites,
  ) {}

  /** {@link recordLocked} in its own transaction, taking the device authority writer. */
  @Transactional()
  async record(
    machineId: string,
    report: unknown,
    meta: { connectionId: string | null; via: OwnerReportVia },
  ): Promise<OwnerReportOutcome> {
    const subject = await this.db
      .selectFrom("device_machines")
      .select(["org_id", "device_id"])
      .where("id", "=", machineId)
      .where("revoked_at", "is", null)
      .executeTakeFirst();
    if (!subject) return "revoked";
    await this.ceilings.lock({ orgId: subject.org_id, deviceId: subject.device_id }, "device");
    return this.recordLocked(machineId, report, meta);
  }

  /**
   * Records one report for `machineId` (the caller holds the device authority writer and has
   * validated the connection). `rootsChanged`: the same message also changed the machine's roots,
   * which already resets Full consent and revokes everything (folded into one publication).
   */
  @Transactional({ propagation: "mandatory" })
  async recordLocked(
    machineId: string,
    raw: unknown,
    meta: {
      connectionId: string | null;
      via: OwnerReportVia;
      rootsChanged?: boolean;
      /**
       * The platform op whose answer carries this report: the change is audited as its source
       * made it (the person, via the web or an approval), once, instead of as the machine's own.
       */
      explainedBy?: { accountId: string; via: string; opId: string; actorTokenId?: string };
    },
  ): Promise<OwnerReportOutcome> {
    const report: DeviceOwnerCeilingV3 = parseOwnerCeilingReportV3(raw);
    const row = await this.db
      .selectFrom("device_machines")
      .select(["org_id", "device_id", "account_id", "owner_report", "local_policy", "roots"])
      .where("id", "=", machineId)
      .where("revoked_at", "is", null)
      .forUpdate()
      .executeTakeFirst();
    if (!row) return "revoked";
    const subject = { orgId: row.org_id, deviceId: row.device_id };
    const stored = storedOwnerReportOf(row.owner_report);
    const decision = decideOwnerReport(stored, report);
    const now = new Date().toISOString();
    if (decision === "stale" && meta.via !== "hello") {
      // a policy frame, answer, status or bind answer committed after a newer report (carriers
      // commit in lock order, not issue order) carries no newer authority: ignored, never blocks
      if (meta.rootsChanged) await this.ceilings.publishLocked(subject, "device", true, true);
      return "stale";
    }
    if (decision === "stale" || decision === "conflict") {
      // a hello (it opens the current connection) regressing the sequence, or the same sequence
      // with other bytes: never replaces the authority, blocks new admissions until a valid report
      await this.write(machineId, {
        ...(stored as StoredOwnerReport),
        blocked: { reason: decision, sequence: report.sequence, at: now },
      });
      if (meta.rootsChanged) await this.ceilings.publishLocked(subject, "device", true, true);
      return decision;
    }
    if (decision === "same") {
      const { blocked: _cleared, ...kept } = stored as StoredOwnerReport;
      await this.write(machineId, { ...kept, connectionId: meta.connectionId, observedAt: now });
      if (meta.rootsChanged) await this.ceilings.publishLocked(subject, "device", true, true);
      return "same";
    }
    // the facts the authority last held: a block only fails admission closed, it is not a change
    // of Full or reach (unblocking with the same facts resets nothing and audits nothing)
    const before =
      stored === null
        ? ownerFactsOf(row)
        : ownerFactsOfReport({
            report: stored.report,
            connectionId: stored.connectionId,
            observedAt: stored.observedAt,
            via: stored.via,
          });
    const next: StoredOwnerReport = {
      report,
      connectionId: meta.connectionId,
      observedAt: now,
      via: meta.via,
    };
    const after = ownerFactsOfReport(next);
    await this.write(machineId, next);
    const fullChanged = before.fullAccess !== after.fullAccess;
    const reachChanged = before.restrictedProjectReach !== after.restrictedProjectReach;
    const domainsChanged =
      JSON.stringify([...before.restrictedAllowedDomains].sort()) !==
      JSON.stringify([...after.restrictedAllowedDomains].sort());
    const roots = machineRootList(row.roots);
    // a new revision with the same visible facts is no new authority: nothing is published
    if (fullChanged || reachChanged || domainsChanged || meta.rootsChanged)
      await this.ceilings.publishLocked(
        subject,
        "device",
        (scope, intent) =>
          meta.rootsChanged === true ||
          ownerReportRevokes(after, scope, intent.method, intent.granted_hosts, roots),
        fullChanged || meta.rootsChanged === true,
      );
    const by = meta.explainedBy;
    if (before.state !== "missing" && (fullChanged || reachChanged))
      await audit(this.db.db, {
        actorAccountId: by?.accountId ?? row.account_id,
        ...(by?.actorTokenId !== undefined && { actorTokenId: by.actorTokenId }),
        orgId: row.org_id,
        action: "device.owner_ceiling_changed",
        target: row.device_id,
        detail: {
          from: {
            fullAccess: before.fullAccess,
            restrictedProjectReach: before.restrictedProjectReach,
          },
          to: {
            fullAccess: after.fullAccess,
            restrictedProjectReach: after.restrictedProjectReach,
          },
          sequence: report.sequence,
          by: by?.accountId ?? row.account_id,
          via: by?.via ?? "device",
          ...(by !== undefined && { opId: by.opId }),
          machineId,
        },
      });
    return "recorded";
  }

  private async write(machineId: string, value: StoredOwnerReport): Promise<void> {
    await this.db
      .updateTable("device_machines")
      .set({ owner_report: JSON.stringify(value) })
      .where("id", "=", machineId)
      .execute();
  }
}
