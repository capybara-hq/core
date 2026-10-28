// biome-ignore-all lint/suspicious/noExplicitAny: test handles over an untyped Kysely
/**
 * The extensions providers over a test's own pool and Redis, for tests that host extensions
 * without a running kernel (Task 5.1 moves them to the Nest application). The host takes the same
 * options the hand-wired host took; they become the config values it reads.
 */

import type { Kysely } from "kysely";
import type { core } from "zod";
import type { KernelDeps } from "../../src/ctx/create-ctx.js";
import type { Keyring } from "../../src/ctx/secrets.js";
import { ExtensionApprovals } from "../../src/extensions/approvals.js";
import { ExtensionBlobs } from "../../src/extensions/blobs.js";
import { ExtensionHost } from "../../src/extensions/host.js";
import type { ExtensionInstalls } from "../../src/extensions/installs.js";
import { OrgExtensionConfigs } from "../../src/extensions/org-config.js";
import { ExtensionRegistry } from "../../src/extensions/registry.js";
import { ReplicaStatusStore } from "../../src/extensions/sources.js";
import type { KernelConfigService } from "../../src/infra/config/kernel-config.service.js";
import { KernelEvents } from "../../src/infra/events/kernel-events.js";
import type { KernelLogger } from "../../src/log.js";
import type { StorageService } from "../../src/storage/storage.service.js";
import { handlesFor, orgLockFor } from "./identity.js";

/** The hand-wired host's options, mapped onto the config the provider reads. */
export interface TestHostOptions {
  registry?: ExtensionRegistry;
  resolveFrom?: string;
  onSecrets?: (values: string[]) => void;
  autoApprove?: boolean;
  status?: ReplicaStatusStore;
  drainMs?: () => number;
  disposeTimeoutMs?: () => number;
  reloadSetupTimeoutMs?: () => number;
  hookTimeoutMs?: () => number;
  installedNames?: () => Promise<string[]>;
  deploymentConfig?: (
    plugin: string,
    fileValue: unknown,
    schema: core.$ZodType | undefined,
  ) => Promise<unknown>;
}

/** `deps.log` as the kernel logger the host injects (`addSecrets` from `onSecrets`, else a no-op). */
function loggerOf(log: KernelDeps["log"], onSecrets?: (values: string[]) => void): KernelLogger {
  return new Proxy(log as object, {
    get(target, key) {
      if (key === "addSecrets") {
        return (
          onSecrets ??
          ((target as { addSecrets?: unknown }).addSecrets as any)?.bind(target) ??
          (() => {})
        );
      }
      if (key === "redact") {
        return ((target as { redact?: unknown }).redact as any)?.bind(target) ?? ((t: string) => t);
      }
      const v = Reflect.get(target, key);
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as KernelLogger;
}

/** An extension host over `deps` (what the hand-wired `testHost(deps, config, opts)` took). */
export function testHost(
  deps: KernelDeps,
  extensionConfig: Record<string, unknown> = {},
  opts: TestHostOptions = {},
): ExtensionHost {
  const h = handlesFor(deps.db);
  const config = {
    get: () => ({
      db: { url: deps.dbUrl, connectTimeoutMs: deps.connectTimeoutMs },
      redis: { url: deps.redisUrl },
      roles: deps.runWorkers ? ["api", "worker"] : ["api"],
      http: {},
      extensionConfig,
      extensionPermissions: { autoApprove: opts.autoApprove === true },
      extensionHost: {
        drainSeconds: (opts.drainMs?.() ?? 30_000) / 1000,
        disposeTimeoutSeconds: (opts.disposeTimeoutMs?.() ?? 10_000) / 1000,
        reloadSetupTimeoutSeconds: (opts.reloadSetupTimeoutMs?.() ?? 60_000) / 1000,
      },
      hooks: { timeoutMs: opts.hookTimeoutMs?.() ?? 5_000 },
    }),
  } as unknown as KernelConfigService;
  const installs = {
    installedNames: async () => (opts.installedNames ? opts.installedNames() : []),
    effectiveDeploymentConfig: async (
      plugin: string,
      fileValue: unknown,
      schema: core.$ZodType | undefined,
    ) =>
      opts.deploymentConfig ? opts.deploymentConfig(plugin, fileValue, schema) : (fileValue ?? {}),
  } as unknown as ExtensionInstalls;
  const status =
    opts.status ??
    ({
      write: async () => {},
      note: async () => {},
      heartbeat: async () => {},
      removeAll: async () => {},
    } as unknown as ReplicaStatusStore);
  return new ExtensionHost(
    opts.registry ?? new ExtensionRegistry(),
    installs,
    approvalsFor(deps.db),
    status,
    config,
    h.db,
    deps.redis,
    deps.busSubscriber,
    deps.keyring,
    deps.locks as never,
    loggerOf(deps.log, opts.onSecrets),
    opts.resolveFrom !== undefined ? { resolveFrom: opts.resolveFrom } : {},
  );
}

/** The permission snapshots over `db`. */
export function approvalsFor(db: Kysely<any>): ExtensionApprovals {
  const h = handlesFor(db);
  return new ExtensionApprovals(h.db, h.txHost);
}

/** The package store over `db` (object storage only when `storage` is given). */
export function blobsFor(
  db: Kysely<any>,
  o: { maxBytes: number; storage?: StorageService },
): ExtensionBlobs {
  const h = handlesFor(db);
  return new ExtensionBlobs(
    h.db,
    h.txHost,
    o.storage ?? ({ available: false } as unknown as StorageService),
    { get: () => ({ packages: { maxBytes: o.maxBytes } }) } as unknown as KernelConfigService,
  );
}

/** This replica's status rows over `db`, with a fixed replica id. */
export function replicaStatusFor(
  db: Kysely<any>,
  replicaId: string,
  redact: (text: string) => string = (t) => t,
): ReplicaStatusStore {
  const s = new ReplicaStatusStore(
    handlesFor(db).db,
    { get: () => ({ http: {} }) } as unknown as KernelConfigService,
    { redact },
  );
  (s as { replicaId: string }).replicaId = replicaId;
  return s;
}

/**
 * Org extension configs over `db` (its own pool) and `host`; `onSecrets` receives the secret values
 * handled (the kernel masks them in its logs).
 */
export function orgConfigsFor(
  db: Kysely<any>,
  keyring: Keyring,
  host: ExtensionHost,
  o: {
    onSecrets?: (values: string[]) => void;
    installed?: { name: string; version: string }[];
  } = {},
): OrgExtensionConfigs {
  const h = handlesFor(db);
  const quiet = { warn() {}, addOrgSecrets: o.onSecrets ?? (() => {}) } as unknown as KernelLogger;
  return new OrgExtensionConfigs(
    h.db,
    h.txHost,
    keyring,
    host,
    orgLockFor(db),
    { list: async () => o.installed ?? [] } as unknown as ExtensionInstalls,
    new KernelEvents(quiet),
    quiet,
  );
}
