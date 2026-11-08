import { randomUUID } from "node:crypto";
import type { Logger, SandboxProvider } from "@capybara-hq/plugin-sdk";
import type { Redis } from "ioredis";
import { type Kysely, sql } from "kysely";
import type { BackgroundLaunchLock } from "../../src/background/launch-lock.js";
import { BackgroundTaskStore } from "../../src/background/store.js";
import type { KernelConfig } from "../../src/config/schema.js";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { KernelDb } from "../../src/infra/database/kernel-db.js";
import type { TransactionHost } from "../../src/infra/database/transaction-host.js";
import { LockService } from "../../src/infra/lock/lock.service.js";
import type { KernelLogger } from "../../src/log.js";
import { SandboxLeases } from "../../src/sandbox/leases.js";
import { DEVICE_PROVIDER, type SandboxProviderEntry } from "../../src/sandbox/providers.js";
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
  return new Cls(new LockService(d.redis, log), d.redis, log, {
    ...(d.ttlMs !== undefined && { ttlMs: d.ttlMs }),
    ...(d.pollMs !== undefined && { pollMs: d.pollMs }),
    ...(d.pathTtlMs !== undefined && { pathTtlMs: d.pathTtlMs }),
  });
}

/** What a test builds a {@link SandboxService} from (the old constructor's deps). */
export interface SandboxServiceDeps {
  db: KernelSchemaDb;
  redis: Redis;
  /** Read at every call; undefined without a provider. */
  provider: () => SandboxProviderEntry | undefined;
  /** A still-loaded provider by plugin name; none when omitted. */
  lookup?: (plugin: string) => SandboxProvider | undefined;
  /** Kernel-internal providers (`@device`), found by name before any extension. */
  internal?: SandboxProviderEntry[];
  config: () => Pick<KernelConfig, "sandbox">;
  log: Partial<Pick<Logger, "info" | "warn" | "error">>;
  /** Lease poll interval (ms), default 100. */
  lockPollMs?: number;
  /** Lease TTL (ms), default 60 s. */
  lockTtlMs?: number;
  /** The leases (default: {@link sandboxLeasesFor} over `redis` with the two values above). */
  leases?: SandboxLeases;
  /** The background task store (default: one over `db`; the sandbox service opens no transaction). */
  background?: Pick<BackgroundTaskStore, "pendingKills" | "clearKill">;
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
    {
      cloud: d.provider,
      forName: (plugin) => {
        const own = d.internal?.find((e) => e.plugin === plugin);
        if (own) return own;
        const impl = d.lookup?.(plugin);
        return impl ? { plugin, impl } : undefined;
      },
    },
    { get: () => d.config() as KernelConfig },
    kernelLog(d.log),
    d.background ??
      new BackgroundTaskStore(
        kernelDbOver(d.db),
        {} as TransactionHost,
        // the sandbox service never reserves a launch
        {} as BackgroundLaunchLock,
      ),
  );
}

/**
 * Inserts a personal environment in `orgId`, owned by `accountId` (default: the org's creator);
 * returns its id. A cloud one records no provider; a `device` one records `@device`.
 */
export async function seedEnvironment(
  // biome-ignore lint/suspicious/noExplicitAny: test databases have no schema types
  raw: Kysely<any>,
  orgId: string,
  accountId?: string,
  source: "cloud" | "device" = "cloud",
): Promise<string> {
  const id = randomUUID();
  const provider = source === "device" ? DEVICE_PROVIDER : null;
  await sql`INSERT INTO capybara.environments
      (id, org_id, owner_kind, owner_account_id, source, provider)
    SELECT ${id}, o.id, 'personal', COALESCE(${accountId ?? null}::text, o.created_by), ${source},
      ${provider}
    FROM capybara.orgs o WHERE o.id = ${orgId}`.execute(raw);
  return id;
}
