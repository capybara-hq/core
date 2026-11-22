import {
  type DeviceRef,
  type DeviceReport,
  parseDeviceReport,
  type SandboxHandle,
  type SandboxPermissionSupport,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable, Optional } from "@nestjs/common";
import { sql } from "kysely";
import { KernelDb } from "../infra/database/kernel-db.js";
import { runOutsideTransaction, TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { LockService } from "../infra/lock/lock.service.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { untilAborted } from "../until-aborted.js";
import { PermissionCeilingWrites, requiresFullExecution } from "./permission-ceiling-writes.js";
import { supportOf } from "./permission-runtime-reports.js";
import { type DeviceProviderEntry, DeviceProviders } from "./providers.js";

/** How long a provider's `report` may take before the refresh gives up (keeps the stored one). */
export const DEVICE_REPORT_TIMEOUT_MS = 10_000;

/** Overrides {@link DEVICE_REPORT_TIMEOUT_MS} (ms; tests only). */
export const DEVICE_REPORT_TIMEOUT = Symbol("DEVICE_REPORT_TIMEOUT");

/** A device's report failures are logged at most once per this window. */
const FAILURE_LOG_WINDOW_MS = 60 * 60_000;

const failureLogKey = (deviceId: string): string => `capk:device-report-failure:${deviceId}`;

/** The revision of a stored report, or null when none (or not a readable one) is stored. */
export function storedRevision(stored: unknown): string | null {
  if (typeof stored !== "object" || stored === null) return null;
  const revision = (stored as { revision?: unknown }).revision;
  return typeof revision === "string" ? revision : null;
}

/** The permission support stored with a report (its `support` key), or null when none passes. */
export function storedSupport(stored: unknown): SandboxPermissionSupport | null {
  if (typeof stored !== "object" || stored === null) return null;
  return supportOf((stored as { support?: unknown }).support);
}

/**
 * A stored report (`devices.report`) checked again ({@link parseDeviceReport}) without its
 * `support` key; null when none is stored or it no longer passes.
 */
export function storedReport(stored: unknown): DeviceReport | null {
  if (typeof stored !== "object" || stored === null) return null;
  const { support: _support, ...report } = stored as Record<string, unknown>;
  try {
    return parseDeviceReport(report);
  } catch {
    return null;
  }
}

/**
 * The crossings a device's provider can enforce now, from its permission support: none when the
 * support is unknown (not implemented, no instance, a failed read) or names why it is unavailable.
 */
function crossingsOf(support: SandboxPermissionSupport | null): {
  outsideSandbox: boolean;
  perOperationHosts: boolean;
} {
  const usable = support !== null && support.unavailableReason === undefined;
  return {
    outsideSandbox: usable && support.outsideSandbox,
    perOperationHosts: usable && support.network.perOperationHosts,
  };
}

/** A provider's answer: its report, and its support when read (absent: keep the stored one). */
interface Answer {
  report: DeviceReport;
  support?: SandboxPermissionSupport | null;
}

/**
 * What {@link DeviceReports.changed} did: `bumped` (the revision changed and the device authority
 * epoch moved), `same` (stored again, nothing published), `not-served` (the device is not a live
 * device bound to the calling provider; nothing read or written).
 */
export type DeviceReportChange = "bumped" | "same" | "not-served";

/**
 * The stored device report (`devices.report`, `report_at`; device-provider spec §6.1, §6.7): what a
 * device's provider last told about it (`device-provider@1` `report()`, with the instance's
 * `permissionSupport()` read at the last {@link changed} that had an instance, kept under the key
 * `support`). The report's text is shown to people; its revision and the stored support drive
 * the device authority epoch below (what an operation may do is still decided by the authority
 * and the provider's own enforcement, never read from here). {@link refresh} (the kernel, on a create or resume) and {@link changed} (the
 * provider, through `ctx.devices.reportChanged`) ask the provider and store the answer; request
 * paths {@link read} the stored copy from PG and never call the provider.
 *
 * The report's revision drives the provider-neutral device authority epoch (§6.7): a stored
 * revision replaced by another one publishes a device ceiling change in the same transaction
 * (`PermissionCeilingWrites.publishLocked`), so approvals, grants and pending admissions bound to
 * the old epoch are stale. Running work is revoked only for the crossings the new support cannot
 * enforce (outside the sandbox, per-call hosts); Full consent is reset when the outside-sandbox
 * crossing changes either way or per-call hosts become possible. A first report replaces no
 * revision and publishes nothing. No in-process state: every comparison reads PG under the device
 * authority writer lock and the row lock.
 */
@Injectable()
export class DeviceReports {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(LockService) private readonly locks: Pick<LockService, "lease">,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<KernelLogger, "warn">,
    @Inject(PermissionCeilingWrites)
    private readonly ceilings: Pick<PermissionCeilingWrites, "lock" | "publishLocked">,
    @Inject(DeviceProviders) private readonly providers: Pick<DeviceProviders, "forDevice">,
    @Optional()
    @Inject(DEVICE_REPORT_TIMEOUT)
    private readonly timeoutMs: number = DEVICE_REPORT_TIMEOUT_MS,
  ) {}

  /**
   * Asks `entry` for the report of `ref`'s device (given up after {@link DEVICE_REPORT_TIMEOUT_MS}
   * or on `signal`, even when the provider ignores its signal), checks it ({@link parseDeviceReport})
   * and stores it with `report_at`, keeping the permission support stored before (the lifecycle
   * reads the instance's support itself; a refresh adds no provider probe),
   * only while the device is live and still bound to `entry` (`devices.provider = entry.plugin`);
   * a replaced revision publishes the device authority change (see the class).
   * `changed`: the stored revision differs from the one before (true for a first report). Never
   * throws: a failing or invalid report leaves the stored one as it was and is logged at most
   * once per device per hour; an abort of `signal` is not logged. Call it outside any transaction
   * (the provider calls must not hold one open).
   */
  async refresh(
    entry: DeviceProviderEntry,
    ref: DeviceRef,
    signal: AbortSignal,
  ): Promise<{ changed: boolean }> {
    let answer: Answer;
    try {
      answer = await this.ask(entry, ref, signal, false);
    } catch (err) {
      if (!signal.aborted) await this.noteFailure(entry, ref.deviceId, err);
      return { changed: false };
    }
    try {
      return { changed: (await this.store(entry.plugin, ref, answer)).changed };
    } catch (err) {
      await this.noteFailure(entry, ref.deviceId, err);
      return { changed: false };
    }
  }

  /**
   * `ctx.devices.reportChanged(deviceId)` of the extension `plugin`: `not-served` unless the
   * device is live and bound to `plugin` (the caller refuses it); otherwise reads the device's
   * report and permission support from `plugin` (its current instance's handle, if any) outside
   * any transaction and stores them as {@link refresh} does. Throws when the report cannot be read
   * or does not pass, so the provider may tell again; a failed support read stores no support
   * (no crossing enforceable: revocation fails closed).
   */
  async changed(
    plugin: string,
    deviceId: string,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<DeviceReportChange> {
    return runOutsideTransaction(async () => {
      const device = await this.db
        .selectFrom("devices as d")
        .innerJoin("orgs as o", "o.id", "d.org_id")
        .select(["d.org_id", "d.provider"])
        .where("d.id", "=", deviceId)
        .where("d.deleted_at", "is", null)
        .where("o.deleted_at", "is", null)
        .executeTakeFirst();
      if (!device || device.provider !== plugin) return "not-served";
      const entry = this.providers.forDevice(plugin);
      if (!entry) throw new Error(`Device provider ${plugin} is not loaded on this replica`);
      const instance = await this.db
        .selectFrom("device_instances")
        .select("handle")
        .where("device_id", "=", deviceId)
        .where("provider", "=", plugin)
        .executeTakeFirst();
      const ref: DeviceRef = {
        deviceId,
        orgId: device.org_id,
        handle: (instance?.handle ?? null) as SandboxHandle | null,
      };
      const answer = await this.ask(entry, ref, signal, true);
      return (await this.store(plugin, ref, answer)).published ? "bumped" : "same";
    });
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
    return storedReport(row?.report);
  }

  /**
   * The stored revision of a live device and the permission support stored with it (null when
   * none was read); null when no report is stored. Reads PG only.
   */
  async current(
    deviceId: string,
  ): Promise<{ revision: string; support: SandboxPermissionSupport | null } | null> {
    const row = await this.db
      .selectFrom("devices")
      .select("report")
      .where("id", "=", deviceId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    const revision = storedRevision(row?.report);
    return revision === null ? null : { revision, support: storedSupport(row?.report) };
  }

  /**
   * The provider's report (checked; throws when it fails or does not pass) and, with
   * `withSupport`, the instance's permission support (null when the provider has none or the read
   * fails or does not pass; absent without `withSupport` or without an instance: the stored one
   * is kept), each bounded and raced so a provider ignoring the signal holds nothing.
   */
  private async ask(
    entry: DeviceProviderEntry,
    ref: DeviceRef,
    signal: AbortSignal,
    withSupport: boolean,
  ): Promise<Answer> {
    const bounded = () => AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]);
    const s1 = bounded();
    // raced, not only signalled: a provider that ignores the signal never holds a lease past it
    const report = parseDeviceReport(await untilAborted(entry.impl.report(ref, s1), s1));
    if (!withSupport) return { report };
    const { handle } = ref;
    const read = entry.impl.permissionSupport?.bind(entry.impl);
    // no instance to ask: what the last instance-backed read said still stands
    if (handle === null) return { report };
    if (!read) return { report, support: null };
    const s2 = bounded();
    const support = await untilAborted(read(handle, s2), s2).then(supportOf, (err: unknown) => {
      if (!signal.aborted)
        this.log.warn("cannot read the device's permission support with its report", {
          deviceId: ref.deviceId,
          provider: entry.plugin,
          err,
        });
      return null;
    });
    return { report, support };
  }

  /**
   * Writes the answer on the device if it is live and bound to `plugin`, under the row lock and
   * then the device authority writer lock, so two stores of one device compare against each
   * other's writes, never against the same old value.
   * `changed`: the revision differs from the stored one; `published`: a stored revision was
   * replaced, so the device authority change was published in this transaction.
   */
  @Transactional()
  private async store(
    plugin: string,
    ref: DeviceRef,
    answer: Answer,
  ): Promise<{ changed: boolean; published: boolean }> {
    const subject = { orgId: ref.orgId, deviceId: ref.deviceId };
    const row = await this.db
      .selectFrom("devices")
      .select("report")
      .where("id", "=", ref.deviceId)
      .where("org_id", "=", ref.orgId)
      .where("provider", "=", plugin)
      .where("deleted_at", "is", null)
      .forNoKeyUpdate()
      .executeTakeFirst();
    // deleted, or bound to another provider than the one that answered: nothing is written
    if (!row) return { changed: false, published: false };
    // the device row first, then the device authority writer: the order of the device writers
    // (`DevicesService` removal and network)
    await this.ceilings.lock(subject, "device");
    const { report } = answer;
    const was = crossingsOf(storedSupport(row.report));
    const support = answer.support === undefined ? storedSupport(row.report) : answer.support;
    await this.db
      .updateTable("devices")
      .set({ report: JSON.stringify({ ...report, support }), report_at: sql<Date>`now()` })
      .where("id", "=", ref.deviceId)
      .execute();
    const before = storedRevision(row.report);
    const changed = before !== report.revision;
    if (!changed || before === null) return { changed, published: false };
    const now = crossingsOf(support);
    await this.ceilings.publishLocked(
      subject,
      "device",
      // running work keeps only the crossings the new support can still enforce
      (scope, intent) =>
        (!now.outsideSandbox && requiresFullExecution(scope)) ||
        (!now.perOperationHosts && intent.granted_hosts.length > 0),
      // Full access approves crossings by itself: a changed outside-sandbox crossing, or per-call
      // hosts becoming possible, needs the person's consent again
      was.outsideSandbox !== now.outsideSandbox ||
        (!was.perOperationHosts && now.perOperationHosts),
    );
    return { changed, published: true };
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
