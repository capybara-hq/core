import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ExtensionManifest,
  OBJECT_STORE_EXTENSION_POINT,
  type ObjectStore,
} from "@capybara-hq/plugin-sdk";
import type { KernelConfig } from "../config/schema.js";
import { ApiError } from "../errors.js";
import { planApprovals, snapshotCovers } from "../extensions/approvals.js";
import { type ExtensionCli, openExtensionCli } from "../extensions/cli.js";
import { assertSecretsReachable } from "../extensions/host.js";
import { importExtensionModule, matchesSection } from "../extensions/instance.js";
import type { PermissionSet } from "../extensions/permission-set.js";
import { packageRootOf, syncPackage } from "../extensions/sync.js";
import type { KernelLogger } from "../log.js";
import { packagePath } from "../packages/tgz.js";
import { PrefixedStorage } from "../storage/storage.service.js";
import { CatalogImportModule } from "./catalog.module.js";
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
 * `provide` (any other ctx access fails). It uses a provider only when replicas would load it:
 * - a config-declared one: its permissions are approved and its deployment config is valid;
 * - else an install record desired enabled (e.g. the bootstrap plugin object-store-s3) whose
 *   reviewed manifest provides `object-store@1` and whose name no config-declared extension takes:
 *   a package with migrations has had them run for its sha256 (`migrated_sha`; the CLI never
 *   migrates), its package's permissions are covered by the approved snapshot (or `autoApprove`),
 *   the package syncs into `syncDir` (checked against its sha256), its module matches the reviewed
 *   manifest, and its deployment config is valid.
 * Config-declared providers are tried first, then install records by name.
 */
export async function loadCliObjectStore(
  cli: Pick<
    ExtensionCli,
    | "inspected"
    | "deploymentConfigs"
    | "deploymentConfigOf"
    | "approvals"
    | "config"
    | "configIssues"
    | "installs"
    | "packageSet"
    | "readPackage"
  >,
  log: Pick<KernelLogger, "warn">,
  syncDir: string,
): Promise<CliObjectStore> {
  const providers = cli.inspected.filter((p) =>
    p.manifest.provides.includes(OBJECT_STORE_EXTENSION_POINT),
  );
  const declared = new Set(cli.inspected.map((p) => p.manifest.name));
  const installed = (await cli.installs.desired()).filter(
    (d) =>
      !declared.has(d.name) &&
      (d.section.manifest?.provides ?? []).includes(OBJECT_STORE_EXTENSION_POINT),
  );
  if (providers.length === 0 && installed.length === 0) {
    return { store: undefined, reason: "no object-store extension is declared or installed" };
  }
  const autoApprove = cli.config.extensionPermissions.autoApprove;
  const sets = new Map(cli.inspected.map((p) => [p.manifest.name, p.permissions]));
  const snapshots = await cli.approvals.all();
  const decisions = planApprovals(
    cli.inspected.map((p) => p.manifest),
    sets,
    snapshots,
    { autoApprove },
  );
  const reasons: string[] = [];
  /** Runs `setup` with the restricted context; the store it provided, or undefined (reason noted). */
  const setUp = async (manifest: ExtensionManifest, config: unknown) => {
    const name = manifest.name;
    let store: ObjectStore | undefined;
    const ctx = new Proxy(
      {
        config,
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
      await manifest.setup(ctx as any);
    } catch (err) {
      log.warn("the CLI cannot set up the object store extension", { plugin: name, err });
      reasons.push(`${name} needs more than ctx.config and ctx.provide`);
      return undefined;
    }
    if (!store) reasons.push(`${name} provided no object store`);
    return store;
  };
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
    const store = await setUp(provider.manifest, cli.deploymentConfigs.get(name) ?? {});
    if (store) return { store };
  }
  for (const d of installed) {
    // Replicas set it up only after its migrations ran (ensureMigrated records migrated_sha); the
    // CLI never migrates, so a package whose migrations have not run for this sha is skipped
    if (d.section.migrations !== undefined && d.migratedSha !== d.sha256) {
      reasons.push(`${d.name} awaits its migrations (a replica runs them when it loads it)`);
      continue;
    }
    let set: PermissionSet;
    try {
      set = await cli.packageSet(d.sha256);
    } catch (err) {
      log.warn("the CLI cannot read an installed object store package", { plugin: d.name, err });
      reasons.push(`${d.name}: its package cannot be read`);
      continue;
    }
    if (!autoApprove && !snapshotCovers(snapshots.get(d.name), set)) {
      reasons.push(`${d.name} awaits permission approval`);
      continue;
    }
    let manifest: ExtensionManifest;
    try {
      const url = await syncPackage(
        syncDir,
        d.name,
        d.sha256,
        { get: (sha) => cli.readPackage(sha) },
        { maxBytes: cli.config.packages.maxBytes },
      );
      manifest = await importExtensionModule(
        url,
        d.name,
        packageRootOf(url, packagePath(d.section.entry)),
      );
      assertSecretsReachable(manifest);
    } catch (err) {
      log.warn("the CLI cannot load an installed object store extension", { plugin: d.name, err });
      reasons.push(`${d.name} cannot be loaded`);
      continue;
    }
    if (!matchesSection(manifest, d.name, d.section.manifest)) {
      reasons.push(`${d.name}: its module does not match the reviewed manifest`);
      continue;
    }
    const config = await cli.deploymentConfigOf(d.name, manifest.config?.deployment);
    if (!config.ok) {
      reasons.push(`${d.name} is not configured (pending deployment config)`);
      continue;
    }
    const store = await setUp(manifest, config.value);
    if (store) return { store };
  }
  return { store: undefined, reason: reasons.join("; ") };
}

/** `storage.unavailable` with the CLI's constraint spelled out (the generic text points to a plugin install). */
class CliStorage extends PrefixedStorage {
  constructor(
    deps: ConstructorParameters<typeof PrefixedStorage>[0],
    private readonly reason: string | undefined,
  ) {
    super(deps);
  }

  override assertAvailable(): void {
    if (this.available) return;
    throw new ApiError(
      "storage.unavailable",
      `Object storage is not available to the CLI (${this.reason ?? "unknown"}). The CLI can use only a config-declared or installed and enabled object-store extension that is approved, configured and whose setup needs only ctx.config and ctx.provide; import this plugin in the admin console instead`,
    );
  }
}

/**
 * The CLI's plugin catalog context (`capybara plugins *`; R13): {@link openExtensionCli} with the
 * catalog's {@link CatalogImportModule}, so {@link PluginImport} and {@link CatalogService} are the
 * kernel's providers. Imports run with actor `null` (the operator of the
 * deployment, like `capybara extensions install`: no enterprise-admin re-check, audits without an
 * actor, permission snapshots written with source `cli`). Files of the plugin (skills, connector
 * templates, icons) go to the deployment's object store, set up in-process from the declared or
 * installed object-store extension (see {@link loadCliObjectStore}; an installed package is synced
 * into a temporary directory removed on `close`); connector templates of connectors the
 * plugin does not bring are checked statically only (the CLI loads no connector).
 */
export async function openCatalogCli(
  config: KernelConfig,
  log: KernelLogger,
  opts: { resolveFrom?: string } = {},
): Promise<CatalogCli> {
  const cli = await openExtensionCli(config, log, { ...opts, modules: [CatalogImportModule] });
  let syncDir: string | undefined;
  const removeSyncDir = async () => {
    if (syncDir !== undefined) await rm(syncDir, { recursive: true, force: true }).catch(() => {});
  };
  try {
    syncDir = await mkdtemp(join(tmpdir(), "capybara-cli-"));
    const { store, ...rest } = await loadCliObjectStore(cli, log, syncDir);
    const storage = new CliStorage(
      {
        provider: () => store,
        plugins: async () => cli.inspected.map((p) => p.manifest.name),
      },
      "reason" in rest ? rest.reason : undefined,
    );
    // Plugin files go to that store; connector templates get static checks only (the CLI loads
    // no connector; the org install re-checks them). Config-declared names come from the
    // inspection (the registry), marketplace imports are not offered by the CLI.
    const imports = cli.app.get(PluginImport);
    imports.useCliStorage(storage);
    const catalog = cli.app.get(CatalogService);
    return {
      ...cli,
      catalog,
      imports,
      async close() {
        await cli.close();
        await removeSyncDir();
      },
    };
  } catch (e) {
    await cli.close();
    await removeSyncDir();
    throw e;
  }
}
