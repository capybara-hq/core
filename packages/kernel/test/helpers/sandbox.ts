import type { Logger, SandboxProvider } from "@capybara-hq/plugin-sdk";
import type { Redis } from "ioredis";
import type { KernelConfig } from "../../src/config/schema.js";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { KernelDb } from "../../src/infra/database/kernel-db.js";
import { LockService } from "../../src/infra/lock/lock.service.js";
import type { KernelLogger } from "../../src/log.js";
import { SandboxLeases } from "../../src/sandbox/leases.js";
import type { SandboxProviderEntry } from "../../src/sandbox/providers.js";
import { SandboxService } from "../../src/sandbox/sandbox.service.js";

/** A kernel logger over a test's partial logger (the missing levels are dropped). */
function kernelLog(log: Partial<Pick<Logger, "info" | "warn" | "error">>): KernelLogger {
  return { debug() {}, info() {}, warn() {}, error() {}, ...log } as unknown as KernelLogger;
}

/**
 * A `KernelDb` over a test's own schema view (`kernelDb(raw)`): the query methods resolve to it
 * (no transaction context; the sandbox service opens none).
 */
function kernelDbOver(db: KernelSchemaDb): KernelDb {
  return Object.create(KernelDb.prototype, { db: { value: db } }) as KernelDb;
}

/** What a test builds a {@link SandboxLeases} from (the old constructor's deps). */
export interface SandboxLeasesTestDeps {
  redis: Redis;
  log: Partial<Pick<Logger, "warn">>;
  ttlMs?: number;
  pollMs?: number;
  pathTtlMs?: number;
}

/** {@link SandboxLeases} (or a test subclass) over `d.redis`, with its tunables set. */
export function sandboxLeasesFor(
  d: SandboxLeasesTestDeps,
  Cls: typeof SandboxLeases = SandboxLeases,
): SandboxLeases {
  const log = kernelLog(d.log);
  const leases = new Cls(new LockService(d.redis, log), d.redis, log);
  if (d.ttlMs !== undefined) leases.ttlMs = d.ttlMs;
  if (d.pollMs !== undefined) leases.pollMs = d.pollMs;
  if (d.pathTtlMs !== undefined) leases.pathTtlMs = d.pathTtlMs;
  return leases;
}

/** What a test builds a {@link SandboxService} from (the old constructor's deps). */
export interface SandboxServiceDeps {
  db: KernelSchemaDb;
  redis: Redis;
  /** Read at every call; undefined without a provider. */
  provider: () => SandboxProviderEntry | undefined;
  /** A still-loaded provider by plugin name; none when omitted. */
  lookup?: (plugin: string) => SandboxProvider | undefined;
  config: () => Pick<KernelConfig, "sandbox">;
  log: Partial<Pick<Logger, "info" | "warn" | "error">>;
  /** Lease poll interval (ms), default 100. */
  lockPollMs?: number;
  /** Lease TTL (ms), default 60 s. */
  lockTtlMs?: number;
  /** The leases (default: {@link sandboxLeasesFor} over `redis` with the two values above). */
  leases?: SandboxLeases;
}

/** A {@link SandboxService} over a test's own database, Redis and provider. */
export function sandboxServiceFor(d: SandboxServiceDeps): SandboxService {
  const leases =
    d.leases ??
    sandboxLeasesFor({
      redis: d.redis,
      log: d.log,
      ...(d.lockTtlMs !== undefined && { ttlMs: d.lockTtlMs }),
      ...(d.lockPollMs !== undefined && { pollMs: d.lockPollMs }),
    });
  return new SandboxService(
    kernelDbOver(d.db),
    d.redis,
    leases,
    { current: d.provider, lookup: (plugin) => d.lookup?.(plugin) },
    { get: () => d.config() as KernelConfig },
    kernelLog(d.log),
  );
}
