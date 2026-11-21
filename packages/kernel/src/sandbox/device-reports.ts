import { type DeviceRef, type DeviceReport, parseDeviceReport } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { LockService } from "../infra/lock/lock.service.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import type { DeviceProviderEntry } from "./providers.js";

/** How long a provider's `report` may take before the refresh gives up (keeps the stored one). */
export const DEVICE_REPORT_TIMEOUT_MS = 10_000;

/** A device's report failures are logged at most once per this window. */
const FAILURE_LOG_WINDOW_MS = 60 * 60_000;

const failureLogKey = (deviceId: string): string => `capk:device-report-failure:${deviceId}`;

/** The revision of a stored report, or null when none (or not a readable one) is stored. */
function storedRevision(stored: unknown): string | null {
  if (typeof stored !== "object" || stored === null) return null;
  const revision = (stored as { revision?: unknown }).revision;
  return typeof revision === "string" ? revision : null;
}

/**
 * The stored device report (`devices.report`, `report_at`; device-provider spec §6.1): what a
 * device's provider last told about it (`device-provider@1` `report()`), shown to people and never
 * used for enforcement. {@link refresh} asks the provider and stores the answer; request paths
 * {@link read} the stored copy from PG and never call the provider.
 */
@Injectable()
export class DeviceReports {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(LockService) private readonly locks: Pick<LockService, "lease">,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<KernelLogger, "warn">,
  ) {}

  /**
   * Asks `entry` for the report of `ref`'s device (bounded at {@link DEVICE_REPORT_TIMEOUT_MS}
   * and by `signal`), checks it ({@link parseDeviceReport}) and stores it with `report_at`, only
   * while the device is live and still bound to `entry` (`devices.provider = entry.plugin`).
   * `changed`: the stored revision differs from the one before (true for a first report). Never
   * throws: a failing or invalid answer leaves the stored report as it was and is logged at most
   * once per device per hour; an abort of `signal` is not logged. Call it outside any transaction
   * (the provider call must not hold one open).
   */
  async refresh(
    entry: DeviceProviderEntry,
    ref: DeviceRef,
    signal: AbortSignal,
  ): Promise<{ changed: boolean }> {
    let report: DeviceReport;
    try {
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(DEVICE_REPORT_TIMEOUT_MS)]);
      report = parseDeviceReport(await entry.impl.report(ref, bounded));
    } catch (err) {
      if (!signal.aborted) await this.noteFailure(entry, ref.deviceId, err);
      return { changed: false };
    }
    try {
      return { changed: await this.store(entry.plugin, ref, report) };
    } catch (err) {
      await this.noteFailure(entry, ref.deviceId, err);
      return { changed: false };
    }
  }

  /**
   * The stored report of a live device of `orgId`, checked again ({@link parseDeviceReport});
   * null when none is stored, the stored one no longer passes, or there is no such device.
   * Reads PG only.
   */
  async read(orgId: string, deviceId: string): Promise<DeviceReport | null> {
    const row = await this.db
      .selectFrom("devices")
      .select("report")
      .where("id", "=", deviceId)
      .where("org_id", "=", orgId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (row?.report == null) return null;
    try {
      return parseDeviceReport(row.report);
    } catch {
      return null;
    }
  }

  /**
   * Writes `report` on the device if it is live and bound to `plugin`; whether its revision
   * differs from the stored one. The row is locked first, so two refreshes of one device compare
   * against each other's writes, never against the same old value.
   */
  @Transactional()
  private async store(plugin: string, ref: DeviceRef, report: DeviceReport): Promise<boolean> {
    const row = await this.db
      .selectFrom("devices")
      .select("report")
      .where("id", "=", ref.deviceId)
      .where("org_id", "=", ref.orgId)
      .where("provider", "=", plugin)
      .where("deleted_at", "is", null)
      .forUpdate()
      .executeTakeFirst();
    // deleted, or bound to another provider than the one that answered: nothing is written
    if (!row) return false;
    await this.db
      .updateTable("devices")
      .set({ report: JSON.stringify(report), report_at: sql<Date>`now()` })
      .where("id", "=", ref.deviceId)
      .execute();
    return storedRevision(row.report) !== report.revision;
  }

  /** Logs a refresh failure, at most once per device per hour (a Redis key with a TTL). */
  private async noteFailure(entry: DeviceProviderEntry, deviceId: string, err: unknown) {
    let first = true;
    try {
      first = await this.locks.lease(failureLogKey(deviceId), "1", FAILURE_LOG_WINDOW_MS);
    } catch {
      // Redis unavailable: log anyway rather than hiding it
    }
    if (first)
      this.log.warn("cannot refresh the device report; the stored one is kept", {
        deviceId,
        provider: entry.plugin,
        err,
      });
  }
}
