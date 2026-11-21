import { randomUUID } from "node:crypto";
import type { Logger } from "@capybara-hq/plugin-sdk";
import type { Redis } from "ioredis";
import { type Kysely, sql } from "kysely";
import type { KernelConfig } from "../../src/config/schema.js";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { DeviceAccess } from "../../src/devices/access.js";
import type { DeviceProviderSelection } from "../../src/devices/device-provider-selection.js";
import type { KernelConfigService } from "../../src/infra/config/kernel-config.service.js";
import { KernelDb } from "../../src/infra/database/kernel-db.js";
import { LockService } from "../../src/infra/lock/lock.service.js";
import type { KernelLogger } from "../../src/log.js";
import type { CloudPermissionSnapshots } from "../../src/sandbox/cloud-permission-snapshot.js";
import { DeviceReports } from "../../src/sandbox/device-reports.js";
import { SandboxLeases } from "../../src/sandbox/leases.js";
import type { LegacyRetirementStore } from "../../src/sandbox/legacy-retirement.js";
import type { SandboxOperationAuthority } from "../../src/sandbox/operation-authority.js";
import type { SandboxOperationIntents } from "../../src/sandbox/operation-intents.js";
import { PermissionFacts } from "../../src/sandbox/permission-facts.js";
import {
  type DeviceProviderEntry,
  type DeviceProviders,
  isInternalProvider,
  LOCAL_PROVIDER,
} from "../../src/sandbox/providers.js";
import { SandboxService } from "../../src/sandbox/sandbox.service.js";
import { handlesFor, instanceWritesFor, retirementFor } from "./identity.js";

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
  /**
   * The loaded `device-provider@1` extensions, read at every call (a device resolves to the one
   * named like its `devices.provider`; the sweeps go over each); none when omitted.
   */
  providers?: () => readonly DeviceProviderEntry[];
  /** Kernel-internal providers (`@local`), found by name before any extension. */
  internal?: DeviceProviderEntry[];
  /**
   * The plugin names on in an org, read at every use (default: every loaded one, in every org).
   * An internal provider is on wherever it is registered, as in `DeviceProviderSelection`.
   */
  onInOrg?: (orgId: string) => readonly string[];
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
  /** The stored device reports (default: {@link deviceReportsFor} over `db` and `redis`). */
  reports?: Pick<DeviceReports, "refresh">;
}

/** {@link DeviceReports} over a test's own database and Redis. */
export function deviceReportsFor(
  db: KernelSchemaDb,
  redis: Redis,
  log: Partial<Pick<Logger, "warn">> = {},
  timeoutMs?: number,
): DeviceReports {
  const h = handlesFor(db);
  const kl = kernelLog(log);
  return new DeviceReports(h.db, h.txHost, new LockService(redis, kl), kl, timeoutMs);
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
  const loaded = () => [...(d.providers?.() ?? [])];
  const providers: Pick<DeviceProviders, "forDevice" | "loaded"> = {
    forDevice: (plugin) =>
      plugin === null
        ? undefined
        : (d.internal?.find((e) => e.plugin === plugin) ??
          loaded().find((e) => e.plugin === plugin)),
    loaded,
  };
  const selection: Pick<DeviceProviderSelection, "isOnInOrg"> = {
    isOnInOrg: async (orgId, plugin) =>
      isInternalProvider(plugin)
        ? providers.forDevice(plugin) !== undefined
        : loaded().some((e) => e.plugin === plugin) &&
          (d.onInOrg === undefined || d.onInOrg(orgId).includes(plugin)),
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
    selection,
    config,
    kernelLog(d.log),
    new PermissionFacts(db, config, providers, new DeviceAccess(db, selection)),
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
    d.reports ?? deviceReportsFor(d.db, d.redis, d.log),
  );
}

/**
 * Inserts a personal device in `orgId`, owned by `accountId` (default: the org's creator);
 * returns its id. A cloud one records `device-fake` (switched on in the org); a `device` one
 * records `@local`.
 */
export async function seedDevice(
  // biome-ignore lint/suspicious/noExplicitAny: test databases have no schema types
  raw: Kysely<any>,
  orgId: string,
  accountId?: string,
  source: "cloud" | "local" = "cloud",
): Promise<string> {
  const id = randomUUID();
  const provider = source === "local" ? LOCAL_PROVIDER : "device-fake";
  await sql`INSERT INTO capybara.devices
      (id, org_id, owner_kind, owner_account_id, source, provider)
    SELECT ${id}, o.id, 'personal', COALESCE(${accountId ?? null}::text, o.created_by), ${source},
      ${provider}
    FROM capybara.orgs o WHERE o.id = ${orgId}`.execute(raw);
  // a device is used only while its provider is on in its org: switch the fake on there
  if (source === "cloud") await enableFakeProvider(raw, orgId);
  return id;
}

/**
 * Switches the fake device provider (`device-fake`, or `plugin`) on in `orgId`: a device can be
 * used only while its provider is on in its org. Harmless for a kernel that did not load it.
 */
export async function enableFakeProvider(
  // biome-ignore lint/suspicious/noExplicitAny: test databases have no schema types
  raw: Kysely<any>,
  orgId: string,
  plugin = "device-fake",
): Promise<void> {
  await sql`INSERT INTO capybara.extension_org_configs (plugin, org_id, enabled)
    VALUES (${plugin}, ${orgId}, true)
    ON CONFLICT (plugin, org_id) DO UPDATE SET enabled = true`.execute(raw);
}
