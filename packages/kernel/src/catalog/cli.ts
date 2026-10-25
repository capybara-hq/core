import { OBJECT_STORE_EXTENSION_POINT, type ObjectStore } from "@capybara-hq/plugin-sdk";
import type { KernelConfig } from "../config/schema.js";
import { ApiError } from "../errors.js";
import { type ExtensionCli, openExtensionCli } from "../extensions/cli.js";
import type { InspectedExtension } from "../extensions/host.js";
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

/**
 * Sets up the deployment's object-store extension inside the CLI process. The CLI hosts no
 * extensions, so this runs only the provider's `setup` with a context that offers `config` and
 * `provide`; a provider that needs anything else cannot be used by the CLI (undefined: the import
 * then fails with `storage.unavailable` when the plugin has files to store). Not configured
 * (pending deployment config) is also undefined.
 */
export async function loadCliObjectStore(
  cli: Pick<ExtensionCli, "inspected" | "deploymentConfigs">,
  log: Pick<KernelLogger, "warn">,
): Promise<ObjectStore | undefined> {
  const provider = cli.inspected.find((p: InspectedExtension) =>
    p.manifest.provides.includes(OBJECT_STORE_EXTENSION_POINT),
  );
  if (!provider) return undefined;
  const name = provider.manifest.name;
  const configured =
    provider.manifest.config?.deployment === undefined || cli.deploymentConfigs.has(name);
  if (!configured) return undefined;
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
    return undefined;
  }
  return store;
}

/**
 * The CLI's plugin catalog context (`capybara plugins *`): {@link openExtensionCli} plus
 * {@link PluginImport} and {@link CatalogService}. Imports run with actor `null` (the operator of the
 * deployment, like `capybara extensions install`: no enterprise-admin re-check, audits without an
 * actor, permission snapshots written with source `cli`). Files of the plugin (skills, connector
 * templates, icons) go to the deployment's object store, loaded in-process from the declared
 * object-store extension; connector templates are checked statically (the CLI loads no connector).
 */
export async function openCatalogCli(
  config: KernelConfig,
  log: KernelLogger,
  opts: { builtin: string[]; resolveFrom?: string },
): Promise<CatalogCli> {
  const cli = await openExtensionCli(config, log, opts);
  try {
    const store = await loadCliObjectStore(cli, log);
    const storage = new StorageService({
      provider: () => store,
      plugins: async () => cli.inspected.map((p) => p.manifest.name),
    });
    const declared = new Map(cli.inspected.map((p) => [p.manifest.name, p.source] as const));
    const imports = new PluginImport({
      db: cli.db,
      config: () => config,
      storage,
      installs: cli.installs,
      ops: cli.ops,
      blobs: { get: (sha256) => cli.readPackage(sha256) },
      declared: () => declared,
      findConnector: () => undefined,
      log,
    });
    const catalog = new CatalogService({
      db: cli.db,
      config: () => config,
      installs: cli.installs,
      ops: cli.ops,
      pluginImport: imports,
      fetchArchive: () =>
        Promise.reject(
          new ApiError("internal", "marketplace imports are not available in the CLI"),
        ),
    });
    return { ...cli, catalog, imports };
  } catch (e) {
    await cli.close();
    throw e;
  }
}
