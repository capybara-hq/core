import { Redis } from "ioredis";
import type { KernelConfig } from "../../config/schema.js";
import type { KernelLogger } from "../../log.js";
import {
  CloudPermissionSnapshots,
  type CloudSnapshotProgress,
  type CloudSnapshotRun,
  readCloudSnapshotProgress,
} from "../../sandbox/cloud-permission-snapshot.js";
import { CloudPermissionSnapshotsModule } from "../../sandbox/cloud-permission-snapshot.module.js";
import {
  type LegacyFreezeResult,
  type LegacyRetirementReport,
  LegacyRetirementStore,
} from "../../sandbox/legacy-retirement.js";
import { LegacyRetirementModule } from "../../sandbox/legacy-retirement.module.js";
import { PermissionAuthorityModule } from "../../sandbox/permission-authority.module.js";
import { PermissionConfigPublication } from "../../sandbox/permission-config-publication.js";
import { KERNEL_VERSION } from "../../version.js";
import { KernelDb } from "../database/kernel-db.js";
import { PRESENCE_DEFAULT_INTERVAL_MS, readLiveReplicas } from "../presence/replica-presence.js";
import { openKernelCli } from "./kernel-cli.module.js";

/**
 * The operator surface of the permission runtime cutover (B-10, B-26): `capybara permissions
 * cutover report | freeze | snapshot`. The report and the freeze use PostgreSQL only (the report
 * reads replica presence from Redis when it answers, and says so when it does not); the snapshot
 * needs Redis, because each device is snapshotted under its lifecycle lease.
 */

/** A live replica as the report shows it. */
export interface CutoverReplica {
  id: string;
  version: string;
  roles: string[];
  startedAt: string;
  /** Runs this CLI's kernel version. */
  sameVersion: boolean;
}

/** `capybara permissions cutover report`. */
export interface PermissionCutoverReport {
  kernelVersion: string;
  /** This CLI's permission configuration is the published one (the snapshot needs it). */
  configCurrent: boolean;
  /**
   * The live replicas by presence (Redis), null when Redis did not answer. A replica on another
   * version may run code without the freeze (unfenced): stop old replicas before the freeze.
   */
  replicas: CutoverReplica[] | null;
  retirement: LegacyRetirementReport;
  snapshot: CloudSnapshotProgress;
}

/** How long the report waits for Redis before it reports replicas as unknown. */
const PRESENCE_CONNECT_TIMEOUT_MS = 2_000;

/** The live replicas, or null when Redis does not answer (the report never fails on it). */
async function liveReplicas(url: string): Promise<CutoverReplica[] | null> {
  const redis = new Redis(url, {
    lazyConnect: true,
    connectTimeout: PRESENCE_CONNECT_TIMEOUT_MS,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
  });
  redis.on("error", () => {});
  try {
    await redis.connect();
    const live = await readLiveReplicas(redis, PRESENCE_DEFAULT_INTERVAL_MS * 3);
    return live.map((r) => ({
      id: r.id,
      version: r.version,
      roles: r.roles,
      startedAt: r.startedAt,
      sameVersion: r.version === KERNEL_VERSION,
    }));
  } catch {
    return null;
  } finally {
    redis.disconnect();
  }
}

/** Opens the PostgreSQL-only context of the report and the freeze, runs `fn` and closes it. */
async function withPgContext<T>(
  config: KernelConfig,
  logger: KernelLogger,
  fn: (app: Awaited<ReturnType<typeof openKernelCli>>) => Promise<T>,
): Promise<T> {
  const app = await openKernelCli(config, {
    logger,
    modules: [LegacyRetirementModule, PermissionAuthorityModule],
    redis: false,
  });
  try {
    return await fn(app);
  } finally {
    await app.close().catch((err: unknown) => {
      logger.debug("permissions cutover: closing the CLI context failed", { err });
    });
  }
}

async function readReport(
  app: Awaited<ReturnType<typeof openKernelCli>>,
  replicas: CutoverReplica[] | null,
): Promise<PermissionCutoverReport> {
  const configCurrent = await app
    .get(PermissionConfigPublication)
    .assertCurrent()
    .then(
      () => true,
      () => false,
    );
  return {
    kernelVersion: KERNEL_VERSION,
    configCurrent,
    replicas,
    retirement: await app.get(LegacyRetirementStore).report(),
    snapshot: await readCloudSnapshotProgress(app.get(KernelDb)),
  };
}

/** The report (no writes). `presence: false` skips the replica presence read. */
export async function permissionCutoverReport(
  config: KernelConfig,
  opts: { logger: KernelLogger; presence?: boolean },
): Promise<PermissionCutoverReport> {
  const replicas = opts.presence === false ? null : await liveReplicas(config.redis.url);
  return withPgContext(config, opts.logger, (app) => readReport(app, replicas));
}

/**
 * Publishes the legacy-launch freeze and enumerates until stable before returning
 * ({@link LegacyRetirementStore.freeze}; idempotent, never undone), then reads the report.
 * Throws `LegacyFreezeUnsettledError` when the enumeration did not settle.
 */
export async function permissionCutoverFreeze(
  config: KernelConfig,
  opts: { logger: KernelLogger; by: string },
): Promise<{ freeze: LegacyFreezeResult; report: PermissionCutoverReport }> {
  return withPgContext(config, opts.logger, async (app) => {
    const freeze = await app.get(LegacyRetirementStore).freeze(opts.by);
    return { freeze, report: await readReport(app, null) };
  });
}

/**
 * Runs the cloud snapshot driver ({@link CloudPermissionSnapshots.snapshotAll}) in a context with
 * the CLI's Redis (the lifecycle leases). Throws `CutoverBarrierError` before the freeze, and the
 * scope denial when this CLI's permission configuration is not the published one.
 */
export async function permissionCutoverSnapshot(
  config: KernelConfig,
  opts: { logger: KernelLogger; signal?: AbortSignal; leaseWaitMs?: number },
): Promise<CloudSnapshotRun> {
  const app = await openKernelCli(config, {
    logger: opts.logger,
    modules: [CloudPermissionSnapshotsModule],
  });
  try {
    return await app.get(CloudPermissionSnapshots).snapshotAll({
      ...(opts.signal !== undefined && { signal: opts.signal }),
      ...(opts.leaseWaitMs !== undefined && { leaseWaitMs: opts.leaseWaitMs }),
    });
  } finally {
    await app.close().catch((err: unknown) => {
      opts.logger.debug("permissions cutover: closing the CLI context failed", { err });
    });
  }
}
