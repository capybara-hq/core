import { isSandboxScopeDeniedError } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { readOrgSettings } from "../orgs/settings.service.js";
import { SandboxLeases } from "./leases.js";
import { LegacyRetirementStore } from "./legacy-retirement.js";
import {
  type AppliedLimits,
  cloudChosenMode,
  cloudSnapshotOf,
  coversHost,
  type DeviceNetwork,
  effectiveDevicePolicy,
  normalizeNetwork,
  readDeploymentDevicePolicy,
  readInstanceLimits,
  sameAppliedExactly,
} from "./modes.js";
import { isExecutionMethod } from "./operation-authority-types.js";
import { PermissionAuthorityLock } from "./permission-authority-lock.js";
import { needsFullCeiling, PermissionCeilingWrites } from "./permission-ceiling-writes.js";
import { PermissionConfigPublication } from "./permission-config-publication.js";
import { PermissionFacts } from "./permission-facts.js";

/**
 * What a snapshot or reconciliation found: `unprobed` (no instance or file system yet: the next
 * create applies the desired limits exactly), `bound` (the recorded applied limits are exactly
 * the desired ones), `reconcile-required` (unknown, stale, wider or pending: no admission until a
 * lifecycle action establishes them; `action` names it), `existing` (already snapshotted, kept),
 * `skipped` (not a live cloud device).
 */
export type CloudSnapshotState =
  | "unprobed"
  | "bound"
  | "reconcile-required"
  | "existing"
  | "skipped";
export interface CloudSnapshotOutcome {
  state: CloudSnapshotState;
  /** The lifecycle action that establishes the exact limits when they are required. */
  action?: "reset-files";
}

/** How long the writer waits for the device's exclusive lifecycle lease (running commands). */
const LEASE_WAIT_MS = 120_000;

/** Devices the driver reads per page. */
const DRIVER_PAGE = 100;

/** One device a {@link CloudPermissionSnapshots.snapshotAll} run snapshotted. */
export interface CloudSnapshotResult extends CloudSnapshotOutcome {
  deviceId: string;
  orgId: string;
}

/** What a {@link CloudPermissionSnapshots.snapshotAll} run did. */
export interface CloudSnapshotRun {
  /** The devices this run snapshotted (empty on a rerun: nothing published). */
  results: CloudSnapshotResult[];
  /** Devices it could not snapshot (lease wait, a failed transaction); left for the next run. */
  failed: { deviceId: string; orgId: string; error: string }[];
  /** Live cloud devices still without a snapshot after the run. */
  pending: number;
  /** Live cloud devices that keep the reconciliation marker (admission blocked until reset). */
  reconcileRequired: string[];
}

/** Where the cloud snapshot stands (read by `capybara permissions cutover report`, too). */
export interface CloudSnapshotProgress {
  /** Live cloud devices. */
  cloudDevices: number;
  /** Live cloud devices without a snapshot yet. */
  pending: number;
  /** Live cloud devices carrying `permission_reconcile_required`. */
  reconcileRequired: string[];
}

/** The live (not deleted) cloud devices of orgs that still exist. */
type DeviceReader = Pick<KernelDb, "selectFrom">;
const liveCloud = (db: DeviceReader) =>
  db
    .selectFrom("devices as d")
    .innerJoin("orgs as g", "g.id", "d.org_id")
    .where("d.source", "=", "cloud")
    .where("d.deleted_at", "is", null)
    .where("g.deleted_at", "is", null);

/** Reads the cloud snapshot's progress; no lock, no lease (a report). */
export async function readCloudSnapshotProgress(db: DeviceReader): Promise<CloudSnapshotProgress> {
  const counts = await liveCloud(db)
    .select((eb) => [
      eb.fn.countAll<string>().as("n"),
      eb.fn.count<string>(sql`CASE WHEN d.owner_full_access IS NULL THEN 1 END`).as("pending"),
    ])
    .executeTakeFirstOrThrow();
  const marked = await liveCloud(db)
    .select("d.id")
    .where("d.permission_reconcile_required", "=", true)
    .orderBy("d.id")
    .execute();
  return {
    cloudDevices: Number(counts.n),
    pending: Number(counts.pending),
    reconcileRequired: marked.map((r) => r.id),
  };
}

/**
 * The B1 cloud per-device authority writer: replaces the old daily mode of a cloud device by an
 * explicit owner Full ceiling and outer network, computed from the device's OLD effective
 * authority (platform switch with its configured / stored precedence, the org's switch and cloud
 * network, the device's narrowing switch, `egress: none`), narrowed by what its instance is known
 * to run, never widened. Each device: the exclusive lifecycle lease outside the transaction, then
 * the device authority write lock (platform -> org -> device order) before the row locks. Written
 * once: a snapshot is never recomputed (a later false stays explicit after a widening). A device
 * whose applied limits are not exactly the desired ones keeps a durable marker that blocks
 * admission ({@link PermissionFacts.assertCloudReconciled}) until {@link reconcile} finds them
 * established; the only action that establishes them without a provider-specific update is a
 * file reset, after which the next create applies them exactly.
 */
@Injectable()
export class CloudPermissionSnapshots {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(SandboxLeases) private readonly leases: SandboxLeases,
    @Inject(PermissionAuthorityLock) private readonly locks: PermissionAuthorityLock,
    @Inject(KernelConfigService)
    private readonly config: Pick<KernelConfigService, "get" | "fieldSource">,
    @Inject(PermissionFacts) private readonly facts: PermissionFacts,
    @Inject(PermissionConfigPublication)
    private readonly publication: Pick<PermissionConfigPublication, "assertCurrent">,
    @Inject(PermissionCeilingWrites)
    private readonly ceilings: Pick<PermissionCeilingWrites, "publishLocked">,
    @Inject(LegacyRetirementStore)
    private readonly retirement: Pick<LegacyRetirementStore, "assertCutoverBarrier">,
  ) {}

  /**
   * The production driver (B-10, `capybara permissions cutover snapshot`): snapshots every live
   * cloud device that has none yet, one device at a time, each under its exclusive lifecycle
   * lease and in its own transaction ({@link snapshot}).
   *
   * - **Barrier.** Refuses unless legacy admission is closed (the freeze published and enumerated,
   *   {@link LegacyRetirementStore.assertCutoverBarrier}) and this replica's permission
   *   configuration is the published one; each device re-checks the latter under the platform
   *   lock, and a failure there stops the run.
   * - **Idempotent.** Only devices without a snapshot are visited, and {@link snapshot} keeps an
   *   existing one under the row lock, so a rerun takes no lease and publishes nothing.
   * - **Resumable.** A device's snapshot, its narrowing publication (epoch, Full consent reset,
   *   exact revocation) and its marker commit together or not at all; a crash or a failed device
   *   leaves it without a snapshot for the next run, never half written or published twice.
   * - Devices whose applied limits are not established keep `permission_reconcile_required`
   *   (listed in the answer) until a file reset reconciles them.
   */
  async snapshotAll(
    opts: { signal?: AbortSignal; leaseWaitMs?: number } = {},
  ): Promise<CloudSnapshotRun> {
    await this.retirement.assertCutoverBarrier();
    await this.publication.assertCurrent();
    const results: CloudSnapshotResult[] = [];
    const failed: CloudSnapshotRun["failed"] = [];
    let after = "";
    for (;;) {
      opts.signal?.throwIfAborted();
      const page = await liveCloud(this.db)
        .select(["d.id", "d.org_id"])
        .where("d.owner_full_access", "is", null)
        .where(sql<boolean>`d.id COLLATE "C" > ${after}`)
        .orderBy(sql`d.id COLLATE "C"`)
        .limit(DRIVER_PAGE)
        .execute();
      for (const d of page) {
        opts.signal?.throwIfAborted();
        const wait = AbortSignal.timeout(opts.leaseWaitMs ?? LEASE_WAIT_MS);
        const signal = opts.signal ? AbortSignal.any([opts.signal, wait]) : wait;
        try {
          const outcome = await this.snapshot(d.org_id, d.id, signal);
          results.push({ deviceId: d.id, orgId: d.org_id, ...outcome });
        } catch (e) {
          // a replica that is not (or no longer) current stops the whole run; the caller's abort too
          if (isSandboxScopeDeniedError(e) || opts.signal?.aborted) throw e;
          failed.push({
            deviceId: d.id,
            orgId: d.org_id,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      if (page.length < DRIVER_PAGE) break;
      after = (page.at(-1) as { id: string }).id;
    }
    const progress = await readCloudSnapshotProgress(this.db);
    return {
      results,
      failed,
      pending: progress.pending,
      reconcileRequired: progress.reconcileRequired,
    };
  }

  /** Snapshots one device under its exclusive lifecycle lease. */
  async snapshot(
    orgId: string,
    deviceId: string,
    signal: AbortSignal = AbortSignal.timeout(LEASE_WAIT_MS),
  ): Promise<CloudSnapshotOutcome> {
    return this.underLease(deviceId, signal, () => this.snapshotLocked(orgId, deviceId));
  }

  /** Re-checks a device carrying the marker; clears it once its limits are established. */
  async reconcile(
    orgId: string,
    deviceId: string,
    signal: AbortSignal = AbortSignal.timeout(LEASE_WAIT_MS),
  ): Promise<CloudSnapshotOutcome> {
    return this.underLease(deviceId, signal, () => this.reconcileLocked(orgId, deviceId));
  }

  /** {@link reconcile} by device id alone (after a file reset); nothing for an unknown device. */
  async reconcileDevice(deviceId: string): Promise<CloudSnapshotOutcome> {
    const row = await this.db
      .selectFrom("devices")
      .select(["org_id", "permission_reconcile_required"])
      .where("id", "=", deviceId)
      .executeTakeFirst();
    if (!row?.permission_reconcile_required) return { state: "existing" };
    return this.reconcile(row.org_id, deviceId);
  }

  private async underLease(
    deviceId: string,
    signal: AbortSignal,
    fn: () => Promise<CloudSnapshotOutcome>,
  ): Promise<CloudSnapshotOutcome> {
    // the lease is a distributed lock: taken outside the transaction, released after the commit
    const lease = await this.leases.acquireExclusive(deviceId, signal, undefined, {
      intent: true,
    });
    try {
      return await this.txHost.run(fn, { propagation: "requires_new" });
    } finally {
      await lease.release();
    }
  }

  @Transactional({ propagation: "mandatory" })
  private async snapshotLocked(orgId: string, deviceId: string): Promise<CloudSnapshotOutcome> {
    const device = await this.lockedDevice(orgId, deviceId);
    if (device === undefined) return { state: "skipped" };
    if (device.owner_full_access !== null) return { state: "existing" };
    // under the platform shared lock: proves this replica reads the converted (current) inputs
    await this.publication.assertCurrent();
    const [deployment, settings] = await Promise.all([
      readDeploymentDevicePolicy(this.db.db, this.config),
      readOrgSettings(this.db.db, orgId),
    ]);
    // the OLD algorithm on the old inputs: the snapshot columns are still empty here
    const old = effectiveDevicePolicy(deployment, settings, cloudChosenMode(device));
    const instance = await this.lockedInstance(deviceId);
    const rec = instance === null ? null : readInstanceLimits(instance.instance_limits);
    // what the instance really runs narrows the snapshot even when a newer value is pending
    const known = rec?.applied ?? null;
    const snap = cloudSnapshotOf(old, known);
    const desired = this.desired(snap.fullAccess, snap.outerNetwork);
    const state: CloudSnapshotState =
      instance === null
        ? "unprobed"
        : rec?.unapplied === null && sameAppliedExactly(known, desired)
          ? "bound"
          : "reconcile-required";
    await this.db
      .updateTable("devices")
      .set({
        owner_full_access: snap.fullAccess,
        outer_network: JSON.stringify(snap.outerNetwork),
        permission_migration: JSON.stringify({
          from: "auto-mode",
          old: { mode: old.mode, network: old.network },
          instance:
            instance === null ? null : { generation: instance.generation, applied: known, state },
        }),
        permission_reconcile_required: state === "reconcile-required",
      })
      .where("id", "=", deviceId)
      .execute();
    // A snapshot narrowed by what the instance really runs changes the device's authority: it
    // goes through the device ceiling writer (epoch, Full consent, exact revocation) in this
    // transaction, under the device write lock already held.
    const fullNarrowed = old.mode === "auto" && !snap.fullAccess;
    const networkNarrowed =
      JSON.stringify(normalizeNetwork(old.network)) !== JSON.stringify(snap.outerNetwork);
    if (fullNarrowed || networkNarrowed) {
      const outer = snap.outerNetwork;
      await this.ceilings.publishLocked(
        { orgId, deviceId },
        "device",
        (scope, row) => {
          if (needsFullCeiling(scope)) return !snap.fullAccess;
          if (outer.kind !== "allowlist" || !("network" in scope) || !isExecutionMethod(row.method))
            return false;
          // an execution outside any allowlist (environment networking) is wider than the outer
          // allowlist; `none` is narrower; an allowlist must be covered host by host
          if (scope.network.kind === "environment") return true;
          if (scope.network.kind !== "allowlist") return false;
          return scope.network.hosts.some((h) => !outer.hosts.some((p) => coversHost(p, h)));
        },
        fullNarrowed,
      );
    }
    return state === "reconcile-required" ? { state, action: "reset-files" } : { state };
  }

  @Transactional({ propagation: "mandatory" })
  private async reconcileLocked(orgId: string, deviceId: string): Promise<CloudSnapshotOutcome> {
    const device = await this.lockedDevice(orgId, deviceId);
    if (device === undefined) return { state: "skipped" };
    if (!device.permission_reconcile_required) return { state: "existing" };
    const instance = await this.lockedInstance(deviceId);
    let state: CloudSnapshotState = "unprobed";
    if (instance !== null) {
      // what the instance must run with now: the snapshot as the current effective policy
      const policy = await this.facts.devicePolicy({ orgId, deviceId });
      const known = this.appliedOf(instance);
      state =
        known !== null && sameAppliedExactly(known, { mode: policy.mode, network: policy.network })
          ? "bound"
          : "reconcile-required";
    }
    if (state !== "reconcile-required")
      await this.db
        .updateTable("devices")
        .set({ permission_reconcile_required: false })
        .where("id", "=", deviceId)
        .execute();
    return state === "reconcile-required" ? { state, action: "reset-files" } : { state };
  }

  private desired(fullAccess: boolean, outer: DeviceNetwork): AppliedLimits {
    return { mode: fullAccess ? "auto" : "sandbox", network: outer };
  }

  /**
   * The device row under the device authority write lock, or undefined (not a live cloud one). The
   * row is locked first (`FOR NO KEY UPDATE`: only non-key columns change), then the permission
   * lock, the order the device writers take (`DevicesService.lockOwn`, the device project writes),
   * then the row is read again under both.
   */
  private async lockedDevice(orgId: string, deviceId: string) {
    const exists = await this.db
      .selectFrom("devices")
      .select("org_id")
      .where("id", "=", deviceId)
      .where("org_id", "=", orgId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (exists === undefined) return undefined;
    await this.locks.acquire({ orgId, deviceId }, { kind: "write", level: "device" });
    const device = await this.db
      .selectFrom("devices")
      .select([
        "source",
        "mode",
        "owner_full_access",
        "permission_reconcile_required",
        "deleted_at",
      ])
      .where("id", "=", deviceId)
      .where("org_id", "=", orgId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (device === undefined || device.deleted_at !== null || device.source !== "cloud")
      return undefined;
    return device;
  }

  /**
   * The device's instance row when an instance or a file system exists (their limits are in
   * force); null when neither does (the next create applies the desired limits exactly).
   */
  private async lockedInstance(deviceId: string) {
    const row = await this.db
      .selectFrom("device_instances")
      .select(["handle", "status", "fs_status", "instance_limits", "generation"])
      .where("device_id", "=", deviceId)
      .forUpdate()
      .executeTakeFirst();
    if (row === undefined) return null;
    // a create that may have acted (creating, even without a handle yet) or any file system left
    // counts: its limits are not established
    const live =
      row.status === "creating" ||
      (row.handle !== null && (row.status === "running" || row.status === "suspended"));
    return live || row.fs_status !== "none" ? row : null;
  }

  /** The exactly known applied limits; null when unknown or a newer value awaits a reset. */
  private appliedOf(row: { instance_limits: unknown }): AppliedLimits | null {
    const rec = readInstanceLimits(row.instance_limits);
    return rec.unapplied !== null ? null : rec.applied;
  }
}
