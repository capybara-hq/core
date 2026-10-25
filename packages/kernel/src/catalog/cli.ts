import { OBJECT_STORE_EXTENSION_POINT, type ObjectStore } from "@capybara-hq/plugin-sdk";
import type { KernelConfig } from "../config/schema.js";
import { ApiError } from "../errors.js";
import { planApprovals, withPreApproved } from "../extensions/approvals.js";
import { type ExtensionCli, openExtensionCli } from "../extensions/cli.js";
import type { KernelLogger } from "../log.js";
import { StorageService } from "../storage/storage.service.js";
import { CatalogService } from "./catalog.service.js";
import { PluginImport } from "./plugin-import.js";

/** {@link openCatalogCli}'s result: the extension CLI context plus the catalog services. */
export interface CatalogCli extends ExtensionCli {
  catalog: CatalogService;
  /** Plugin import (prepare / confirm). The CLI acts without an account (actor `null`). */
  imports: PluginImport;
}

/** What the CLI can do with the deployment's object store, and why not when it cannot. */
export type CliObjectStore = { store: ObjectStore } | { store: undefined; reason: string };

/**
 * Sets up the deployment's object-store extension inside the CLI process. The CLI hosts no
 * extensions, so this runs only the provider's `setup` with a context that offers `config` and
 * `provide` (any other ctx access fails). It uses the provider only when replicas would load it: it
 * is builtin or config-declared, its permissions are approved (builtin ones are pre-approved) and
 * its deployment config is valid.
 */
export async function loadCliObjectStore(
  cli: Pick<
    ExtensionCli,
    "inspected" | "deploymentConfigs" | "approvals" | "config" | "configIssues"
  >,
  log: Pick<KernelLogger, "warn">,
): Promise<CliObjectStore> {
  const providers = cli.inspected.filter((p) =>
    p.manifest.provides.includes(OBJECT_STORE_EXTENSION_POINT),
  );
  if (providers.length === 0) {
    return { store: undefined, reason: "no object-store extension is declared" };
  }
  const sets = new Map(cli.inspected.map((p) => [p.manifest.name, p.permissions]));
  const snapshots = withPreApproved(
    await cli.approvals.all(),
    cli.inspected.filter((p) => p.source === "builtin").map((p) => p.manifest),
    sets,
  );
  const decisions = planApprovals(
    cli.inspected.map((p) => p.manifest),
    sets,
    snapshots,
    { autoApprove: cli.config.extensionPermissions.autoApprove },
  );
  const reasons: string[] = [];
  for (const provider of providers) {
    const name = provider.manifest.name;
    const decision = decisions.find((d) => d.plugin === name);
    if (decision?.action === "pending") {
      reasons.push(`${name} awaits permission approval`);
      continue;
    }
    const hasConfig = provider.manifest.config?.deployment !== undefined;
    if (cli.configIssues.has(name) || (hasConfig && !cli.deploymentConfigs.has(name))) {
      reasons.push(`${name} is not configured (pending deployment config)`);
      continue;
    }
    let store: ObjectStore | undefined;
    const ctx = new Proxy(
      {
        config: cli.deploymentConfigs.get(name) ?? {},
        provide(point: string, impl: unknown) {
          if (point === OBJECT_STORE_EXTENSION_POINT) store = impl as ObjectStore;
        },
      },
      {
        get(target, prop, receiver) {
          if (prop in target) return Reflect.get(target, prop, receiver);
          throw new Error(`the CLI does not support ctx.${String(prop)}`);
        },
      },
    );
    try {
      // biome-ignore lint/suspicious/noExplicitAny: a restricted context stands in for the full one
      await provider.manifest.setup(ctx as any);
    } catch (err) {
      log.warn("the CLI cannot set up the object store extension", { plugin: name, err });
      reasons.push(`${name} needs more than ctx.config and ctx.provide`);
      continue;
    }
    if (store) return { store };
    reasons.push(`${name} provided no object store`);
  }
  return { store: undefined, reason: reasons.join("; ") };
}

/** `storage.unavailable` with the CLI's constraint spelled out (the generic text points to a plugin install). */
class CliStorage extends StorageService {
  constructor(
    deps: ConstructorParameters<typeof StorageService>[0],
    private readonly reason: string | undefined,
  ) {
    super(deps);
  }

  override assertAvailable(): void {
    if (this.available) return;
    throw new ApiError(
      "storage.unavailable",
      `Object storage is not available to the CLI (${this.reason ?? "unknown"}). The CLI can use only a builtin or config-declared object-store extension that is approved, configured and whose setup needs only ctx.config and ctx.provide; import this plugin in the admin console instead`,
    );
  }
}

/**
 * The CLI's plugin catalog context (`capybara plugins *`): {@link openExtensionCli} plus
 * {@link PluginImport} and {@link CatalogService}. Imports run with actor `null` (the operator of the
 * deployment, like `capybara extensions install`: no enterprise-admin re-check, audits without an
 * actor, permission snapshots written with source `cli`). Files of the plugin (skills, connector
 * templates, icons) go to the deployment's object store, set up in-process from the declared
 * object-store extension (see {@link loadCliObjectStore}); connector templates of connectors the
 * plugin does not bring are checked statically only (the CLI loads no connector).
 */
export async function openCatalogCli(
  config: KernelConfig,
  log: KernelLogger,
  opts: { builtin: string[]; resolveFrom?: string },
): Promise<CatalogCli> {
  const cli = await openExtensionCli(config, log, opts);
  try {
    const { store, ...rest } = await loadCliObjectStore(cli, log);
    const storage = new CliStorage(
      {
        provider: () => store,
        plugins: async () => cli.inspected.map((p) => p.manifest.name),
      },
      "reason" in rest ? rest.reason : undefined,
    );
    const declared = new Map(cli.inspected.map((p) => [p.manifest.name, p.source] as const));
    const imports = new PluginImport({
      db: cli.db,
      config: () => config,
      storage,
      installs: cli.installs,
      ops: cli.ops,
      blobs: { get: (sha256) => cli.readPackage(sha256) },
      declared: () => declared,
      // The CLI loads no connectors: templates get static checks only (the org install re-checks)
      findConnector: () => undefined,
      connectorsLoaded: false,
      log,
    });
    const catalog = new CatalogService({
      db: cli.db,
      config: () => config,
      installs: cli.installs,
      ops: cli.ops,
      pluginImport: imports,
      // Unreachable from the CLI: only marketplace imports (CatalogService.importFromMarketplace)
      // download archives, and the CLI offers file, npm and direct git imports only.
      fetchArchive: () =>
        Promise.reject(
          new ApiError("internal", "marketplace imports are not available in the CLI"),
        ),
      // Only marketplace imports send a marketplace token; a direct git import has none
      marketplaceToken: async () => undefined,
    });
    return { ...cli, catalog, imports };
  } catch (e) {
    await cli.close();
    throw e;
  }
}
