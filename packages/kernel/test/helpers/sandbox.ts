import { randomUUID } from "node:crypto";
import type { Logger, SandboxProvider } from "@capybara-hq/plugin-sdk";
import type { Redis } from "ioredis";
import { type Kysely, sql } from "kysely";
import type { KernelConfig } from "../../src/config/schema.js";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { DeviceAccess } from "../../src/devices/access.js";
import type { KernelConfigService } from "../../src/infra/config/kernel-config.service.js";
import { KernelDb } from "../../src/infra/database/kernel-db.js";
import { LockService } from "../../src/infra/lock/lock.service.js";
import type { KernelLogger } from "../../src/log.js";
import type { CloudPermissionSnapshots } from "../../src/sandbox/cloud-permission-snapshot.js";
import { SandboxLeases } from "../../src/sandbox/leases.js";
import type { LegacyRetirementStore } from "../../src/sandbox/legacy-retirement.js";
import type { SandboxOperationAuthority } from "../../src/sandbox/operation-authority.js";
import type { SandboxOperationIntents } from "../../src/sandbox/operation-intents.js";
import { PermissionFacts } from "../../src/sandbox/permission-facts.js";
import type { SandboxProviders } from "../../src/sandbox/providers.js";
import { LOCAL_PROVIDER, type SandboxProviderEntry } from "../../src/sandbox/providers.js";
import { SandboxService } from "../../src/sandbox/sandbox.service.js";
import { instanceWritesFor, retirementFor } from "./identity.js";

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
  /** Kernel-internal providers (`@local`), found by name before any extension. */
  internal?: SandboxProviderEntry[];
  config: () => Pick<KernelConfig, "sandbox" | "devices">;
  log: Partial<Pick<Logger, "info" | "warn" | "error">>;
  /** Lease poll interval (ms), default 100. */
  lockPollMs?: number;
  /** Lease TTL (ms), default 60 s. */
  lockTtlMs?: number;
  /** The leases (default: {@link sandboxLeasesFor} over `redis` with the two values above). */
  leases?: SandboxLeases;
  /**
   * The operation intents the takeover and resume cleanup use (B-1; default: no intents, every
   * revocation a no-op, nothing owed).
   */
  operationIntents?: Partial<SandboxOperationIntents>;
  /** The retirement obligations (8.5; default: the real store over `db`). */
  retirement?: LegacyRetirementStore;
  /** The cloud snapshot reconcile (B-12; default: every device already reconciled). */
  snapshots?: Pick<CloudPermissionSnapshots, "reconcileHeld">;
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
  const db = kernelDbOver(d.db);
  const providers: Pick<SandboxProviders, "cloud" | "forName"> = {
    cloud: d.provider,
    forName: (plugin) => {
      const own = d.internal?.find((e) => e.plugin === plugin);
      if (own) return own;
      const impl = d.lookup?.(plugin);
      return impl ? { plugin, impl } : undefined;
    },
  };
  const config: Pick<KernelConfigService, "get" | "fieldSource"> = {
    get: () => d.config() as KernelConfig,
    fieldSource: (path: string) =>
      path === "devices.outsideSandbox" && d.config().devices.outsideSandbox !== undefined
        ? ("file" as const)
        : undefined,
  };
  return new SandboxService(
    kernelDbOver(d.db),
    d.redis,
    leases,
    providers,
    config,
    kernelLog(d.log),
    new PermissionFacts(db, config, providers, new DeviceAccess(db, providers)),
    {
      oweHolderRevocations: async () => {},
      revokeHolders: async () => {},
      revokeIncarnation: async () => {},
      owedRevocations: async () => [],
      acknowledgeRevocation: async () => {},
      ...d.operationIntents,
    } as unknown as SandboxOperationIntents,
    {} as SandboxOperationAuthority,
    instanceWritesFor(d.db),
    d.retirement ?? retirementFor(d.db),
    d.snapshots ?? { reconcileHeld: async () => ({ state: "existing" }) },
  );
}

/**
 * Inserts a personal device in `orgId`, owned by `accountId` (default: the org's creator);
 * returns its id. A cloud one records no provider; a `device` one records `@local`.
 */
export async function seedDevice(
  // biome-ignore lint/suspicious/noExplicitAny: test databases have no schema types
  raw: Kysely<any>,
  orgId: string,
  accountId?: string,
  source: "cloud" | "local" = "cloud",
): Promise<string> {
  const id = randomUUID();
  const provider = source === "local" ? LOCAL_PROVIDER : null;
  await sql`INSERT INTO capybara.devices
      (id, org_id, owner_kind, owner_account_id, source, provider)
    SELECT ${id}, o.id, 'personal', COALESCE(${accountId ?? null}::text, o.created_by), ${source},
      ${provider}
    FROM capybara.orgs o WHERE o.id = ${orgId}`.execute(raw);
  return id;
}
