// The catalog's item and version helpers (no providers), shared by CatalogService and PluginImport:
// kept out of catalog.service.ts so plugin-import.ts never imports a module whose provider injects
// PluginImport (an ESM import cycle would run that class's decorators before PluginImport exists).
import type {
  Connector,
  ConnectorTemplateSpec,
  LocalizedName,
  MarketplaceEntry,
  PluginManifest,
} from "@capybara-hq/plugin-sdk";
import { sql } from "kysely";
import type { KernelConfig } from "../config/schema.js";
import type { KernelSchemaDb, SourceFormat } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { enabledExtensionsByOrg } from "../extensions/enabled.js";
import { audit } from "../identity/audit.js";
import type { StorageService } from "../storage/storage.service.js";
import { endpointCredentialIssues } from "../tools/endpoint.js";
import type {
  CatalogItemView,
  CatalogPolicy,
  CatalogVersionSource,
  PermissionsMismatch,
  SourceDetail,
} from "./catalog.service.js";
import type { TranslationReport } from "./claude/report.js";
import { gitLocationIdentity } from "./git-source.js";
import {
  entryCompatible,
  entryContentChanged,
  type ImportedAs,
  sourceEffective,
} from "./marketplaces.service.js";
import { schemaHasPath } from "./schema-path.js";
import { compareVersions, newestFirst, sameRelease, withBuild } from "./versions.js";

/**
 * The object storage prefix of one import (relative to `deployment/`):
 * `directory/<itemId>/<version>/<importId>/`. Each import gets a new `importId`, so the losing one of
 * two concurrent imports of the same version never overwrites the committed version's files; reads
 * always go through the `object_prefix` stored on the version row. Build metadata's `+` is written
 * as `_` (a `+` in a key can turn into a space through URL query encoding).
 */
export const catalogObjectPrefix = (itemId: string, version: string, importId: string) =>
  `directory/${itemId}/${version.replace(/\+/g, "_")}/${importId}/`;

const PUT_CONCURRENCY = 8;

/**
 * Checks a connector template against the loaded connector `c` (problem paths start with `at`): the
 * endpoint matches its `endpointSchema` and carries no credential-like headers / query / URL user
 * info (the same rule as connector installs); every `editableEndpoint` path exists in the endpoint
 * schema.
 */
export function templateProblems(c: Connector, t: ConnectorTemplateSpec, at: string): string[] {
  const problems: string[] = [];
  const r = c.endpointSchema.safeParse(t.endpoint);
  if (!r.success) {
    for (const i of r.error.issues as { path: PropertyKey[]; message: string }[]) {
      problems.push(`${[`${at}.endpoint`, ...i.path.map(String)].join(".")}: ${i.message}`);
    }
  } else {
    for (const leak of endpointCredentialIssues(r.data)) {
      problems.push(`${at}.${leak.path}: ${leak.message}`);
    }
  }
  for (const p of t.editableEndpoint ?? []) {
    if (!schemaHasPath(c.endpointSchema, p.split("."))) {
      problems.push(
        `${at}.editableEndpoint "${p}" is not a field of the ${t.connector} connector's endpoint`,
      );
    }
  }
  return problems;
}

/** Writes the files to `deployment/<prefix><path>` ({@link PUT_CONCURRENCY} at a time). */
export async function putCatalogFiles(
  storage: StorageService,
  prefix: string,
  files: { path: string; size: number; data: Uint8Array }[],
): Promise<void> {
  const store = storage.deployment();
  const queue = [...files];
  await Promise.all(
    Array.from({ length: Math.min(PUT_CONCURRENCY, queue.length) }, async () => {
      for (let f = queue.shift(); f; f = queue.shift()) {
        await store.put(`${prefix}${f.path}`, f.data, {
          contentType: "application/octet-stream",
          size: f.size,
        });
      }
    }),
  );
}

/** Compares the marketplace's permission summary with the computed keys ({@link PermissionsMismatch}). */
export function permissionsMismatch(
  declared: string[] | undefined,
  actual: string[] | undefined,
): PermissionsMismatch {
  if (declared === undefined || actual === undefined) return null;
  const want = new Set(declared);
  const have = new Set(actual);
  const missing = [...have].filter((k) => !want.has(k)).sort();
  const extra = [...want].filter((k) => !have.has(k)).sort();
  return missing.length > 0 || extra.length > 0 ? { missing, extra } : null;
}

/** The fields the list shows (the item's publisher / description / displayName). */
export interface CatalogListing {
  publisher: string;
  description: string;
  displayName: LocalizedName | null;
}

/** Input of {@link writeCatalogVersion}. */
export interface CatalogVersionWrite {
  /** null: the CLI (no account). */
  actor: string | null;
  actorTokenId?: string;
  name: string;
  /** null: a git plugin without package.json. */
  packageName: string | null;
  /**
   * The version recorded (from {@link precheckCatalogImport}: the plugin's own, or with build
   * metadata when that release was imported with other content).
   */
  version: string;
  /** The content digest of the plugin's files. */
  contentDigest: string;
  /** The normalized plugin.json. */
  manifest: PluginManifest;
  listing: CatalogListing;
  /** The id of the item to create when there is none yet (the one the storage prefix used). */
  newItemId: string;
  source: {
    source: CatalogVersionSource;
    ref: string;
    integrity?: string;
    detail?: SourceDetail;
  };
  /** Imported from a marketplace: the item records it. */
  marketplaceId?: string;
  objectPrefix: string | null;
  extensionSha256: string | null;
  files: { path: string; size: number; sha256: string }[];
  size: number;
  /** The format the plugin was read from (default `capybara`). */
  sourceFormat?: SourceFormat;
  /** The translation report of a Claude Code plugin. */
  translation?: TranslationReport | null;
  /** The root LICENSE text. */
  licenseText?: string | null;
  /** The root LICENSE was too long (or not UTF-8) to store. */
  licenseTruncated?: boolean;
  /** Merged into the detail of the `catalog.imported` audit. */
  auditDetail?: Record<string, unknown>;
}

/**
 * The live item of a name, with the source identity of its latest version
 * ({@link sourceIdentity}; null when there is none).
 */
async function liveItem(db: KernelSchemaDb, name: string) {
  const item = await db
    .selectFrom("catalog_items")
    .select(["id", "package_name", "latest_version", "marketplace_id"])
    .where("name", "=", name)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (!item) return undefined;
  const latest = await db
    .selectFrom("catalog_item_versions")
    .select("source_detail")
    .where("item_id", "=", item.id)
    .where("version", "=", item.latest_version)
    .executeTakeFirst();
  return {
    ...item,
    source: sourceIdentity(
      (latest?.source_detail as SourceDetail | null) ?? undefined,
      item.marketplace_id ?? undefined,
    ),
  };
}

/**
 * The identity of a git source, `<host>/<repo>:<path>` (host lower case, no `.git`), or null when
 * the source is not git. An item without package.json is identified by it instead of a package name.
 */
export function gitIdentity(detail: SourceDetail | undefined): string | null {
  if (detail === undefined || !("commit" in detail)) return null;
  return gitLocationIdentity(detail);
}

/**
 * What identifies the source of a plugin without package.json: `git <host>/<repo>:<path>`, or, for
 * a marketplace archive (a skills-only tgz without plugin.json), `marketplace <id>` (the
 * marketplace vouches for its entries; archive URLs change from version to version). null for
 * anything else.
 */
function sourceIdentity(
  detail: SourceDetail | undefined,
  marketplaceId: string | undefined,
): string | null {
  const git = gitIdentity(detail);
  if (git !== null) return `git ${git}`;
  if (detail !== undefined && "url" in detail && marketplaceId !== undefined) {
    return `marketplace ${marketplaceId}`;
  }
  return null;
}

/** The versions of an item, with what tells their content apart. */
async function itemVersions(db: KernelSchemaDb, itemId: string) {
  return db
    .selectFrom("catalog_item_versions")
    .select(["version", "content_digest", "integrity"])
    .where("item_id", "=", itemId)
    .execute();
}

/** What is being imported, as far as the version conflict rules need it. */
export interface ImportIdentity {
  packageName: string | null;
  /** The plugin's own version (plugin.json, else the fallback of spec §5.3). */
  version: string;
  contentDigest: string;
  integrity?: string;
  detail?: SourceDetail;
  marketplaceId?: string;
}

/** `atConfirm`: found under the lock at confirm (another import committed after the review). */
const versionExists = (version: string, sameContent: boolean, atConfirm = false) =>
  new ApiError(
    "catalog.version_exists",
    (sameContent
      ? `Version ${version} of this catalog item is already imported with the same content`
      : `Version ${version} of this catalog item has already been imported`) +
      (atConfirm
        ? " (by another import since this one was prepared); prepare the import again"
        : ""),
  );

type ExistingVersion = { version: string; content_digest: string | null; integrity: string | null };

/**
 * No version of the release of `p.version` (equal but for build metadata) holds the same content
 * (digest; for a version without one, the same integrity), else `catalog.version_exists`.
 */
function assertNewContent(
  existing: ExistingVersion[],
  p: Pick<ImportIdentity, "version" | "contentDigest" | "integrity">,
  atConfirm = false,
): void {
  const same = existing.find(
    (v) =>
      sameRelease(v.version, p.version) &&
      (v.content_digest !== null
        ? v.content_digest === p.contentDigest
        : v.integrity !== null && v.integrity === p.integrity),
  );
  if (same) throw versionExists(same.version, true, atConfirm);
}

/**
 * The version a new import records (Decision 6, spec §5.3): the plugin's own version, unless that
 * release is already imported. A version of the same release (equal but for build metadata) with
 * the same content (digest; for versions without one, the same integrity) -> `catalog.version_exists`
 * "already imported"; other content -> `<version>+git.<sha12>` (git) or `+sha256.<12>` (any other
 * source, the digest's first 12 hex), never overwriting the imported version. A git commit already
 * recorded with other content (a Claude Code plugin whose marketplace entry changed while its own
 * commit did not, see `claudeContentDigest`) falls back to `+sha256.<12>`.
 */
export function recordedVersion(existing: ExistingVersion[], p: ImportIdentity): string {
  assertNewContent(existing, p);
  if (!existing.some((v) => v.version === p.version)) return p.version;
  const d = p.detail;
  const byDigest = withBuild(p.version, `sha256.${p.contentDigest.slice(0, 12)}`);
  let next =
    d !== undefined && "commit" in d
      ? withBuild(p.version, `git.${d.commit.slice(0, 12)}`)
      : byDigest;
  if (existing.some((v) => v.version === next)) next = byDigest;
  if (existing.some((v) => v.version === next)) throw versionExists(next, false);
  return next;
}

/**
 * Conflict precheck before writing (no lock; {@link writeCatalogVersion}'s re-check inside the
 * transaction is final): an item with the same name from another npm package (or, without one,
 * another git source) -> `catalog.name_conflict`; the release already imported with the same
 * content -> `catalog.version_exists`. Returns the existing item (undefined when there is none) and
 * the version to record ({@link recordedVersion}).
 */
export async function precheckCatalogImport(
  db: KernelSchemaDb,
  name: string,
  p: ImportIdentity,
): Promise<{ existing: { id: string } | undefined; version: string }> {
  const existing = await liveItem(db, name);
  if (!existing) return { existing, version: p.version };
  assertSameSource(existing, p.packageName, sourceIdentity(p.detail, p.marketplaceId));
  return { existing, version: recordedVersion(await itemVersions(db, existing.id), p) };
}

/**
 * Writes a catalog version in the caller's transaction (`db` is its handle; the caller has
 * re-checked the enterprise admin and holds the name's {@link CatalogItemLock}): checks conflicts again (the same source; no version of
 * the release with the same content; `version` not taken meanwhile), creates the item when there is
 * none or adds the version (latest and display fields change only for a newer version, a version
 * equal but for build metadata being newer as the later import), and writes the version row (with
 * its content digest) and the `catalog.imported` audit. Returns the item id.
 */
export async function writeCatalogVersion(
  db: KernelSchemaDb,
  w: CatalogVersionWrite,
): Promise<string> {
  const t = db;
  const { name, version, listing } = w;
  const live = await liveItem(t, name);
  let id: string;
  if (live) {
    id = live.id;
    assertSameSource(live, w.packageName, sourceIdentity(w.source.detail, w.marketplaceId));
    const existing = await itemVersions(t, id);
    // the same content under any version of the release, then the recorded version itself
    assertNewContent(
      existing,
      {
        version,
        contentDigest: w.contentDigest,
        ...(w.source.integrity !== undefined && { integrity: w.source.integrity }),
      },
      true,
    );
    if (existing.some((v) => v.version === version)) throw versionExists(version, false, true);
    const newer = compareVersions(version, live.latest_version) >= 0;
    await t
      .updateTable("catalog_items")
      .set({
        updated_at: sql<Date>`now()` as unknown as Date,
        ...(w.marketplaceId !== undefined && { marketplace_id: w.marketplaceId }),
        ...(newer && {
          latest_version: version,
          publisher: listing.publisher,
          description: listing.description,
          display_name: listing.displayName ? JSON.stringify(listing.displayName) : null,
        }),
      })
      .where("id", "=", id)
      .execute();
  } else {
    id = w.newItemId;
    await t
      .insertInto("catalog_items")
      .values({
        id,
        name,
        package_name: w.packageName,
        publisher: listing.publisher,
        description: listing.description,
        display_name: listing.displayName ? JSON.stringify(listing.displayName) : null,
        latest_version: version,
        created_by: w.actor,
        marketplace_id: w.marketplaceId ?? null,
      })
      .execute();
  }
  await t
    .insertInto("catalog_item_versions")
    .values({
      item_id: id,
      version,
      manifest: JSON.stringify(w.manifest),
      source: w.source.source,
      source_ref: w.source.ref,
      integrity: w.source.integrity ?? null,
      source_detail: w.source.detail !== undefined ? JSON.stringify(w.source.detail) : null,
      content_digest: w.contentDigest,
      object_prefix: w.objectPrefix,
      extension_sha256: w.extensionSha256,
      files: JSON.stringify(w.files.map(({ path, size, sha256 }) => ({ path, size, sha256 }))),
      size: w.size,
      imported_by: w.actor,
      source_format: w.sourceFormat ?? "capybara",
      translation: w.translation != null ? JSON.stringify(w.translation) : null,
      license_text: w.licenseText ?? null,
      license_truncated: w.licenseTruncated === true,
    })
    .execute();
  await audit(t, {
    ...(w.actor !== null && { actorAccountId: w.actor }),
    ...(w.actorTokenId !== undefined && { actorTokenId: w.actorTokenId }),
    action: "catalog.imported",
    target: id,
    detail: {
      name,
      version,
      source: w.source.source,
      sourceRef: w.source.ref,
      contentDigest: w.contentDigest,
      ...(w.extensionSha256 !== null && { sha256: w.extensionSha256 }),
      ...(w.source.integrity !== undefined && { integrity: w.source.integrity }),
      ...(w.marketplaceId !== undefined && { marketplaceId: w.marketplaceId }),
      ...w.auditDetail,
    },
  });
  return id;
}

/**
 * An extension name belongs to the npm package that first installed it (`extension_name_owners`,
 * Ruling P3): when another package owns it, the import is refused right away with
 * `extension.name_conflict` (the same code as at install), instead of failing only at deploy time.
 */
export async function assertPluginNameOwner(
  db: KernelSchemaDb,
  name: string,
  packageName: string | null,
): Promise<void> {
  const owner = await db
    .selectFrom("extension_name_owners")
    .select("package_name")
    .where("name", "=", name)
    .executeTakeFirst();
  if (owner && owner.package_name !== packageName) {
    throw new ApiError(
      "extension.name_conflict",
      `Extension name ${name} belongs to package ${owner.package_name}; ${packageLabel(packageName)} cannot use it`,
    );
  }
}

/** "package <name>", or what a plugin without package.json is called in messages. */
const packageLabel = (p: string | null) =>
  p === null ? "a plugin without package.json" : `package ${p}`;

/**
 * Whether a plugin may add a version to an existing item: the same npm package, or, for an item
 * without package.json, the same source ({@link sourceIdentity}: git host, repo and path, so
 * unrelated repos that resolve to the same name never merge; or the same marketplace for an
 * archive); never a mix of the two.
 */
function assertSameSource(
  item: { package_name: string | null; source: string | null },
  packageName: string | null,
  source: string | null,
): void {
  const from = (p: string | null, src: string | null) =>
    p !== null ? `package ${p}` : (src ?? "a plugin without package.json");
  const same =
    item.package_name !== null
      ? item.package_name === packageName
      : packageName === null && item.source !== null && item.source === source;
  if (!same) {
    throw new ApiError(
      "catalog.name_conflict",
      `A catalog item with this name comes from ${from(item.package_name, item.source)}; ${from(packageName, source)} cannot add versions to it`,
    );
  }
}

/** A catalog version as {@link marketplaceLatest} compares it with its marketplace entries. */
type RecordedVersion = ImportedAs & { imported_at?: Date };

/** What the marketplace says about a marketplace-imported item. */
export interface MarketplaceStatus {
  /** See {@link CatalogItemView.latestMarketplaceVersion}. */
  latest: string | null;
  /** See {@link CatalogItemView.contentChanged}. */
  contentChanged: boolean;
}

/**
 * For each marketplace-imported item, its marketplace (when enabled): the highest compatible
 * version listed, and whether a compatible entry's content changed at an imported version.
 */
export async function marketplaceLatest(
  db: KernelSchemaDb,
  config: KernelConfig,
  items: { id: string; name: string; marketplace_id?: string | null }[],
  versions: ReadonlyMap<string, readonly RecordedVersion[]>,
): Promise<Map<string, MarketplaceStatus>> {
  const out = new Map<string, MarketplaceStatus>();
  const sourced = items.filter((i) => typeof i.marketplace_id === "string");
  if (sourced.length === 0) return out;
  const rows = await db
    .selectFrom("marketplace_entries as e")
    .innerJoin("marketplaces as s", "s.id", "e.source_id")
    .select([
      "e.source_id",
      "e.name",
      "e.version",
      "e.entry",
      "e.head_commit",
      "e.tree_oid",
      "s.builtin",
      "s.enabled",
      "s.url",
      "s.last_commit",
    ])
    .where("e.source_id", "in", [...new Set(sourced.map((i) => i.marketplace_id as string))])
    .where("e.name", "in", [...new Set(sourced.map((i) => i.name))])
    .execute();
  for (const i of sourced) {
    const listed = rows.filter(
      (r) =>
        r.source_id === i.marketplace_id &&
        r.name === i.name &&
        sourceEffective(r, config) &&
        entryCompatible(r.entry as MarketplaceEntry),
    );
    const [best] = listed
      .filter((r) => r.version !== "")
      .map((r) => r.version)
      .sort(newestFirst);
    const recorded = versions.get(i.id) ?? [];
    out.set(i.id, {
      latest: best ?? null,
      contentChanged: listed.some((r) =>
        entryContentChanged(
          r.entry as MarketplaceEntry,
          {
            marketplaceId: r.source_id,
            headCommit: r.head_commit,
            treeOid: r.tree_oid,
            url: r.url,
            lastCommit: r.last_commit,
          },
          recorded,
        ),
      ),
    });
  }
  return out;
}

/** Org install counts per item (see {@link CatalogItemView.installs}). */
export async function countInstalls(
  db: KernelSchemaDb,
  items: { id: string; name: string; latest_version: string }[],
  versions: ReadonlyMap<string, { version: string; extension_sha256: string | null }[]>,
): Promise<Map<string, number>> {
  const orgs = new Map<string, Set<string>>(items.map((i) => [i.id, new Set<string>()]));
  const installed = await db
    .selectFrom("plugin_installs")
    .select(["item_id", "org_id"])
    .where(
      "item_id",
      "in",
      items.map((i) => i.id),
    )
    .where("status", "in", ["installed", "upgrading"])
    .execute();
  for (const r of installed) orgs.get(r.item_id)?.add(r.org_id);
  const withExtension = items.filter(
    (i) =>
      (versions.get(i.id) ?? []).find((v) => v.version === i.latest_version)?.extension_sha256 !=
      null,
  );
  if (withExtension.length > 0) {
    const enabled = await db
      .selectFrom(enabledExtensionsByOrg(db).as("en"))
      .select(["en.plugin", "en.org_id"])
      .where(
        "en.plugin",
        "in",
        withExtension.map((p) => p.name),
      )
      .execute();
    for (const i of withExtension) {
      for (const r of enabled) if (r.plugin === i.name) orgs.get(i.id)?.add(r.org_id);
    }
  }
  return new Map([...orgs].map(([id, set]) => [id, set.size]));
}

export function itemView(
  i: {
    id: string;
    name: string;
    publisher: string;
    display_name: LocalizedName | null;
    description: string;
    policy: CatalogPolicy;
    latest_version: string;
    marketplace_id?: string | null;
    updated_at: Date;
  },
  versions: { version: string; source: string; imported_at?: Date }[],
  installs = 0,
  marketplace: MarketplaceStatus = { latest: null, contentChanged: false },
): CatalogItemView {
  const sorted = [...versions].sort((a, b) =>
    newestFirst(
      { version: a.version, importedAt: a.imported_at ?? null },
      { version: b.version, importedAt: b.imported_at ?? null },
    ),
  );
  const top = sorted[0]?.version ?? i.latest_version;
  const latestMarketplaceVersion = marketplace.latest;
  return {
    id: i.id,
    name: i.name,
    publisher: i.publisher,
    displayName: i.display_name,
    description: i.description,
    policy: i.policy,
    latestVersion: i.latest_version,
    versions: sorted.map((v) => v.version),
    installs,
    source: versions.find((v) => v.version === i.latest_version)?.source ?? "file",
    marketplaceId: i.marketplace_id ?? null,
    latestMarketplaceVersion,
    newerInMarketplace:
      latestMarketplaceVersion !== null && compareVersions(latestMarketplaceVersion, top) > 0,
    contentChanged: marketplace.contentChanged,
    updatedAt: i.updated_at.toISOString(),
  };
}
