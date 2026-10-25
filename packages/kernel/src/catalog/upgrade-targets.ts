import type { PluginManifest } from "@capybara-hq/plugin-sdk";
import type { Transaction } from "kysely";
import type { KernelDatabase, KernelDb } from "../db/kernel-schema.js";
import type { ExtensionHost } from "../extensions/host.js";
import { compareVersions } from "./versions.js";

type Trx = Transaction<KernelDatabase>;

/**
 * Which versions an org may upgrade an installed plugin to (package ecosystem spec §10, Decision
 * 10, Ruling 8):
 * - a plugin with an extension follows the deployment: the only target is the catalog version
 *   whose extension package (sha256) is the one installed on the deployment, the newest import on
 *   ties (`1.0.0` and `1.0.0+sha256.x` can share an extension version with different bytes); an
 *   extension loaded from the startup config (builtin / config, no package) is matched by its
 *   version;
 * - a purely declarative plugin may move to any other imported version (an older one is a
 *   rollback).
 */

/** The extension the deployment runs for a plugin name. */
export interface DeployedExtension {
  /** The installed package's sha256 (null for a builtin / config extension). */
  sha256: string | null;
  version: string;
}

/** A catalog version row as the target rules read it. */
export interface TargetVersion {
  version: string;
  manifest: unknown;
  extension_sha256: string | null;
  imported_at: Date;
}

/**
 * The deployment's extension for plugin `name`: its install record (`extension_installs`, the
 * deployment's desired package), else the extension this replica loaded from the startup config;
 * undefined when the deployment runs none.
 */
export async function deployedExtension(
  db: KernelDb | Trx,
  host: Pick<ExtensionHost, "manifests">,
  name: string,
): Promise<DeployedExtension | undefined> {
  const row = await db
    .selectFrom("extension_installs")
    .select(["sha256", "version"])
    .where("name", "=", name)
    .executeTakeFirst();
  if (row) return { sha256: row.sha256, version: row.version };
  const loaded = host.manifests().find((m) => m.name === name);
  return loaded ? { sha256: null, version: loaded.version } : undefined;
}

const extensionVersionOf = (v: TargetVersion): string | undefined =>
  (v.manifest as PluginManifest).extension?.manifest.version;

/** Whether catalog version `v` carries the deployment's extension `d`. */
export const runsDeployed = (v: TargetVersion, d: DeployedExtension): boolean =>
  d.sha256 !== null
    ? v.extension_sha256 === d.sha256
    : (v.manifest as PluginManifest).extension !== undefined && extensionVersionOf(v) === d.version;

/**
 * The catalog version an org install of an extension-bearing plugin may move to: the one carrying
 * the deployment's extension, the newest import on ties; undefined when none does.
 */
export function deploymentTarget(
  versions: readonly TargetVersion[],
  d: DeployedExtension | undefined,
): TargetVersion | undefined {
  if (d === undefined) return undefined;
  let best: TargetVersion | undefined;
  for (const v of versions) {
    if (!runsDeployed(v, d)) continue;
    if (
      best === undefined ||
      v.imported_at.getTime() > best.imported_at.getTime() ||
      (v.imported_at.getTime() === best.imported_at.getTime() && compareVersions(v, best) > 0)
    ) {
      best = v;
    }
  }
  return best;
}

/** What an install view says about upgrades (Decision 10). */
export interface UpgradeInfo {
  /** The version an upgrade can move to now (the highest allowed target), null when none. */
  upgradeAvailable: string | null;
  /** An extension-bearing plugin whose org version is not the one the deployment runs. */
  deploymentPending: boolean;
}

/**
 * The upgrade info of org installs (`itemId`, `name`, `version`), keyed by `itemId@version`; reads
 * the items' catalog versions and the deployment's extensions in a few queries.
 */
export async function upgradeInfo(
  db: KernelDb,
  host: Pick<ExtensionHost, "manifests">,
  installs: readonly { itemId: string; name: string; version: string }[],
): Promise<Map<string, UpgradeInfo>> {
  const out = new Map<string, UpgradeInfo>();
  if (installs.length === 0) return out;
  const rows = await db
    .selectFrom("catalog_item_versions")
    .select(["item_id", "version", "manifest", "extension_sha256", "imported_at"])
    .where("item_id", "in", [...new Set(installs.map((i) => i.itemId))])
    .execute();
  const deployed = new Map<string, DeployedExtension | undefined>();
  for (const i of installs) {
    const versions = rows.filter((r) => r.item_id === i.itemId);
    const current = versions.find((v) => v.version === i.version);
    if (current && (current.manifest as PluginManifest).extension !== undefined) {
      if (!deployed.has(i.name)) deployed.set(i.name, await deployedExtension(db, host, i.name));
      const d = deployed.get(i.name);
      const target = deploymentTarget(versions, d);
      out.set(`${i.itemId}@${i.version}`, {
        upgradeAvailable: target && target.version !== i.version ? target.version : null,
        deploymentPending: d !== undefined && !runsDeployed(current, d),
      });
      continue;
    }
    let newest: TargetVersion | undefined;
    for (const v of versions) {
      if (newest === undefined || compareVersions(v, newest) > 0) newest = v;
    }
    const newer =
      newest !== undefined &&
      newest.version !== i.version &&
      (current === undefined
        ? compareVersions(newest.version, i.version) > 0
        : compareVersions(newest, current) > 0);
    out.set(`${i.itemId}@${i.version}`, {
      upgradeAvailable: newer ? (newest as TargetVersion).version : null,
      deploymentPending: false,
    });
  }
  return out;
}
