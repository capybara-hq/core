import {
  type Connector,
  type ConnectorTemplateSpec,
  type LocalizedName,
  type MarketplaceEntry,
  marketplaceEntryVersion,
  type PluginManifest,
} from "@capybara-hq/plugin-sdk";
import { sql, type Transaction } from "kysely";
import semver from "semver";
import type { KernelConfig } from "../config/schema.js";
import type { KernelDatabase, KernelDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import type { ExtensionAdminOps } from "../extensions/admin-ops.js";
import type { ExtensionInstalls } from "../extensions/installs.js";
import type { AdminExtensionView } from "../extensions/permission-view.js";
import { audit } from "../identity/audit.js";
import { lockEnterpriseAdminsAndAuthorize } from "../identity/enterprise-admin.js";
import type { StorageService } from "../storage/storage.service.js";
import { endpointCredentialIssues } from "../tools/endpoint.js";
import {
  entryCompatible,
  HOST_VERSIONS,
  loadMarketplaceEntry,
  sourceEffective,
} from "./marketplaces.service.js";
import type { PluginImport, PluginReview } from "./plugin-import.js";
import { cancelPendingRequests } from "./requests.service.js";
import { schemaHasPath } from "./schema-path.js";

/** Item policy (C22): allow (default for new imports) / needs_approval / disabled (no new installs; existing ones stay). */
export type CatalogPolicy = "allow" | "needs_approval" | "disabled";

/** A catalog item (list entry). Every item is a plugin. */
export interface CatalogItemView {
  id: string;
  name: string;
  publisher: string;
  displayName: LocalizedName | null;
  description: string;
  policy: CatalogPolicy;
  latestVersion: string;
  /** Every version, newest first by semver. */
  versions: string[];
  /**
   * Orgs that installed it: orgs with an installed plugin install of the item, plus, when its latest
   * version has an extension, orgs that enabled that extension.
   */
  installs: number;
  /** The latest version's source (file / npm / marketplace). */
  source: string;
  /**
   * The marketplace an item was imported from (`official` or an enterprise marketplace id); null
   * when imported by hand or when that marketplace was deleted.
   */
  marketplaceId: string | null;
  /**
   * The item's highest compatible version in its marketplace (when enabled); null when the item was
   * not imported from a marketplace, the marketplace is disabled or the entry is gone.
   */
  latestMarketplaceVersion: string | null;
  /**
   * `latestMarketplaceVersion` is newer than the newest imported version (the UI shows "newer
   * version"; never imported automatically).
   */
  newerInMarketplace: boolean;
  updatedAt: string;
}

/** One version of an item. */
export interface CatalogItemVersionView {
  version: string;
  source: "file" | "npm" | "marketplace";
  sourceRef: string;
  integrity: string | null;
  /** The normalized plugin.json (skills and connector templates listed). */
  manifest: PluginManifest;
  /** Files stored under the version's object prefix (skills, connector templates, icons). */
  files: { path: string; size: number; sha256: string }[];
  size: number;
  /** The extension's package in the package store (null without an extension). */
  extensionSha256: string | null;
  importedBy: string | null;
  importedAt: string;
}

/** Item detail (deleted items included: `deletedAt` set). */
export interface CatalogItemDetail {
  item: CatalogItemView & { packageName: string; deletedAt: string | null };
  versions: CatalogItemVersionView[];
}

export interface CatalogServiceDeps {
  db: KernelDb;
  config: () => KernelConfig;
  installs: Pick<ExtensionInstalls, "fetchMarketplacePackage">;
  ops: Pick<ExtensionAdminOps, "install">;
  /** Plugin import (a marketplace entry goes through its prepare). */
  pluginImport: Pick<PluginImport, "prepare">;
  /** Downloads a marketplace archive source, verified against its integrity. */
  fetchArchive: (
    archive: { url: string; integrity: string },
    signal?: AbortSignal,
  ) => Promise<{ bytes: Uint8Array; integrity: string }>;
}

/** Audits carry the PAT when a personal token made the call. */
export interface ActorOpts {
  actorTokenId?: string;
}

type Trx = Transaction<KernelDatabase>;

/**
 * The marketplace's permission summary differs from the keys computed from the package (a warning,
 * never a refusal; C26): `missing` = asked by the package, not listed; `extra` = listed, not asked.
 * null when they agree, the marketplace gave no summary or the plugin has no extension.
 */
export type PermissionsMismatch = { missing: string[]; extra: string[] } | null;

/**
 * The result of {@link CatalogService.importFromMarketplace}: a staging id and the review (HTTP
 * 200), confirmed with `POST /api/v1/admin/catalog/imports/:stagingId/confirm`.
 */
export interface MarketplaceImportResult {
  stagingId: string;
  review: PluginReview;
  permissionsMismatch: PermissionsMismatch;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => new ApiError("catalog.item_not_found", "Catalog item not found");
/** An archive URL as recorded (origin + path): a query string or fragment may carry a token. */
export const archiveRef = (url: string): string => {
  const u = new URL(url);
  return `${u.origin}${u.pathname}`;
};

const sourceUnsupported = (name: string, form: "path" | "git") =>
  new ApiError(
    "marketplace.source_unsupported",
    `Marketplace entry ${name} has a ${form} source; git and path sources arrive with git marketplaces (phase A)`,
  );

/**
 * The object storage prefix of one import (relative to `deployment/`):
 * `directory/<itemId>/<version>/<importId>/`. Each import gets a new `importId`, so the losing one of
 * two concurrent imports of the same version never overwrites the committed version's files; reads
 * always go through the `object_prefix` stored on the version row.
 */
export const catalogObjectPrefix = (itemId: string, version: string, importId: string) =>
  `directory/${itemId}/${version}/${importId}/`;

/** Default / largest page size of the list. */
export const CATALOG_LIST_DEFAULT_LIMIT = 200;
export const CATALOG_LIST_MAX_LIMIT = 1000;

const PUT_CONCURRENCY = 8;

const bySemverDesc = (a: string, b: string) => semver.rcompare(a, b);

/**
 * Enterprise catalog items (D9 / C21 / C22, `/api/v1/admin/catalog/*`, enterprise admins only). One
 * kind: every item is a plugin (spec §4), imported through {@link PluginImport} (prepare -> confirm,
 * one review); this service lists and shows items, changes policy, deletes, installs an item's
 * extension on the deployment, and prepares marketplace imports. Stateless, shared by every replica.
 */
export class CatalogService {
  constructor(private readonly d: CatalogServiceDeps) {}

  /**
   * Prepares the import of one marketplace entry (C25 / C26, spec §5.2): `version` defaults to the
   * newest compatible version the marketplace lists for `name`; the entry must be compatible with
   * the host (`marketplace.incompatible`); an npm source is downloaded from the configured registry
   * and an archive source from its URL, both always verified against the marketplace's integrity
   * (`marketplace.integrity_mismatch`, nothing written); `path` / `git` sources arrive with git
   * marketplaces (`marketplace.source_unsupported`). The package must match the entry (name,
   * version, npm package: `marketplace.package_mismatch`), then the same review as any plugin
   * import ({@link PluginImport.prepare}) with source `marketplace` (ref
   * `<marketplaceId>:<npm>@<version>` or `<marketplaceId>:<archive URL>`), confirmed with
   * `POST /api/v1/admin/catalog/imports/:stagingId/confirm`. Marketplace missing ->
   * `marketplace.not_found`; disabled, or the entry / version missing -> `marketplace.entry_not_found`.
   */
  async importFromMarketplace(
    actor: string,
    input: { marketplaceId: string; name: string; version?: string },
    opts: ActorOpts & { signal?: AbortSignal } = {},
  ): Promise<MarketplaceImportResult> {
    const entry = await loadMarketplaceEntry(
      this.d.db,
      this.d.config(),
      input.marketplaceId,
      input.name,
      input.version,
    );
    const version = marketplaceEntryVersion(entry);
    if (!entryCompatible(entry)) {
      throw new ApiError(
        "marketplace.incompatible",
        `${entry.name}${version !== null ? `@${version}` : ""} needs kernel >= ${entry.minKernel}; this deployment runs kernel ${HOST_VERSIONS.kernel}`,
      );
    }
    const src = entry.source;
    let got: { bytes: Uint8Array; integrity: string };
    let ref: string;
    if ("npm" in src) {
      got = await this.d.installs.fetchMarketplacePackage(
        { package: src.npm.package, version: src.npm.version, integrity: src.npm.integrity },
        opts.signal,
      );
      ref = `${input.marketplaceId}:${src.npm.package}@${src.npm.version}`;
    } else if ("archive" in src) {
      got = await this.d.fetchArchive(src.archive, opts.signal);
      ref = `${input.marketplaceId}:${archiveRef(src.archive.url)}`;
    } else {
      throw sourceUnsupported(entry.name, "path" in src ? "path" : "git");
    }
    const staged = await this.d.pluginImport.prepare(
      actor,
      got.bytes,
      { kind: "marketplace", ref, integrity: got.integrity, marketplaceId: input.marketplaceId },
      {
        ...(opts.actorTokenId !== undefined && { actorTokenId: opts.actorTokenId }),
        expect: {
          marketplace: {
            name: entry.name,
            version,
            ...("npm" in src && { packageName: src.npm.package }),
            ...(entry.permissions !== undefined && { permissions: entry.permissions.keys }),
          },
        },
      },
    );
    return {
      stagingId: staged.stagingId,
      review: staged.review,
      permissionsMismatch: staged.permissionsMismatch,
    };
  }

  /**
   * Item list (deleted items excluded by default), ordered by name, id. Paging: `limit`
   * defaults to {@link CATALOG_LIST_DEFAULT_LIMIT}, at most {@link CATALOG_LIST_MAX_LIMIT}, `offset`
   * defaults to 0; use the returned array directly when only the first page is needed.
   */
  async list(
    q: { includeDeleted?: boolean; limit?: number; offset?: number } = {},
  ): Promise<CatalogItemView[]> {
    return (await this.page(q)).items;
  }

  /** Same as {@link list}, plus the offset of the next page (null when there is none). */
  async page(
    q: { includeDeleted?: boolean; limit?: number; offset?: number } = {},
  ): Promise<{ items: CatalogItemView[]; nextOffset: number | null }> {
    const limit = Math.min(
      Math.max(1, q.limit ?? CATALOG_LIST_DEFAULT_LIMIT),
      CATALOG_LIST_MAX_LIMIT,
    );
    const offset = Math.max(0, q.offset ?? 0);
    let query = this.d.db
      .selectFrom("catalog_items")
      .selectAll()
      .orderBy("name")
      .orderBy("id")
      .limit(limit + 1)
      .offset(offset);
    if (!q.includeDeleted) query = query.where("deleted_at", "is", null);
    const rows = await query.execute();
    const nextOffset = rows.length > limit ? offset + limit : null;
    const items = rows.slice(0, limit);
    if (items.length === 0) return { items: [], nextOffset: null };
    const versions = await this.d.db
      .selectFrom("catalog_item_versions")
      .select(["item_id", "version", "source", "extension_sha256"])
      .where(
        "item_id",
        "in",
        items.map((i) => i.id),
      )
      .execute();
    const byItem = new Map<
      string,
      { version: string; source: string; extension_sha256: string | null }[]
    >();
    for (const v of versions) {
      const list = byItem.get(v.item_id) ?? [];
      list.push(v);
      byItem.set(v.item_id, list);
    }
    const installs = await countInstalls(this.d.db, items, byItem);
    const latest = await marketplaceLatest(this.d.db, this.d.config(), items);
    return {
      items: items.map((i) =>
        itemView(i, byItem.get(i.id) ?? [], installs.get(i.id) ?? 0, latest.get(i.id) ?? null),
      ),
      nextOffset,
    };
  }

  /** Item detail (with every version; deleted items too). Missing -> `catalog.item_not_found`. */
  async get(itemId: string): Promise<CatalogItemDetail> {
    if (!UUID_RE.test(itemId)) throw notFound();
    const item = await this.d.db
      .selectFrom("catalog_items")
      .selectAll()
      .where("id", "=", itemId)
      .executeTakeFirst();
    if (!item) throw notFound();
    const rows = await this.d.db
      .selectFrom("catalog_item_versions")
      .selectAll()
      .where("item_id", "=", itemId)
      .execute();
    rows.sort((a, b) => bySemverDesc(a.version, b.version));
    const installs = await countInstalls(this.d.db, [item], new Map([[item.id, rows]]));
    const latest = await marketplaceLatest(this.d.db, this.d.config(), [item]);
    return {
      item: {
        ...itemView(item, rows, installs.get(item.id) ?? 0, latest.get(item.id) ?? null),
        packageName: item.package_name,
        deletedAt: item.deleted_at?.toISOString() ?? null,
      },
      versions: rows.map((v) => ({
        version: v.version,
        source: v.source,
        sourceRef: v.source_ref,
        integrity: v.integrity,
        manifest: v.manifest as PluginManifest,
        files: v.files,
        size: Number(v.size),
        extensionSha256: v.extension_sha256,
        importedBy: v.imported_by,
        importedAt: v.imported_at.toISOString(),
      })),
    };
  }

  /**
   * Changes the policy (audit `catalog.policy_changed`, not written when unchanged). Deleted /
   * missing -> `catalog.item_not_found`.
   */
  async setPolicy(
    actor: string,
    itemId: string,
    policy: CatalogPolicy,
    opts: ActorOpts = {},
  ): Promise<CatalogItemView> {
    if (!UUID_RE.test(itemId)) throw notFound();
    await this.d.db.transaction().execute(async (trx) => {
      await lockEnterpriseAdminsAndAuthorize(trx, actor);
      const row = await trx
        .selectFrom("catalog_items")
        .select(["name", "policy"])
        .where("id", "=", itemId)
        .where("deleted_at", "is", null)
        .forUpdate()
        .executeTakeFirst();
      if (!row) throw notFound();
      if (row.policy === policy) return;
      await trx
        .updateTable("catalog_items")
        .set({ policy, updated_at: sql<Date>`now()` as unknown as Date })
        .where("id", "=", itemId)
        .execute();
      await audit(trx, {
        actorAccountId: actor,
        ...(opts.actorTokenId !== undefined && { actorTokenId: opts.actorTokenId }),
        action: "catalog.policy_changed",
        target: itemId,
        detail: { name: row.name, from: row.policy, to: policy },
      });
    });
    return this.view(itemId);
  }

  /**
   * Deletes the item (soft delete, audit `catalog.removed`; requests still pending are cancelled in
   * the same transaction): versions and stored files are kept (installed components still refer to
   * them), organizations no longer see it; the same name can later be imported again as a new
   * item. Deleted / missing -> `catalog.item_not_found`.
   */
  async remove(actor: string, itemId: string, opts: ActorOpts = {}): Promise<void> {
    if (!UUID_RE.test(itemId)) throw notFound();
    await this.d.db.transaction().execute(async (trx) => {
      await lockEnterpriseAdminsAndAuthorize(trx, actor);
      const row = await trx
        .updateTable("catalog_items")
        .set({
          deleted_at: sql<Date>`now()` as unknown as Date,
          updated_at: sql<Date>`now()` as unknown as Date,
        })
        .where("id", "=", itemId)
        .where("deleted_at", "is", null)
        .returning(["name"])
        .executeTakeFirst();
      if (!row) throw notFound();
      // Pending requests for a deleted item are pointless: cancel them in the same transaction
      await cancelPendingRequests(trx, { itemId }, actor, "item_removed", opts);
      await audit(trx, {
        actorAccountId: actor,
        ...(opts.actorTokenId !== undefined && { actorTokenId: opts.actorTokenId }),
        action: "catalog.removed",
        target: itemId,
        detail: { name: row.name },
      });
    });
  }

  /**
   * Installs the extension of one version of an item on the deployment
   * (`ExtensionAdminOps.install`: a new install is disabled, a version change keeps the desired
   * state; audit `extension.installed`), with the install record linked to the item (F-AA). The
   * returned status may be `pending_approval` when the version's permissions are not approved yet.
   * A version without an extension -> `catalog.no_extension`; item or version missing ->
   * `catalog.item_not_found`.
   */
  async installToDeployment(
    actor: string,
    itemId: string,
    version: string,
    opts: ActorOpts = {},
  ): Promise<AdminExtensionView> {
    if (!UUID_RE.test(itemId)) throw notFound();
    const item = await this.d.db
      .selectFrom("catalog_items")
      .select(["id", "name"])
      .where("id", "=", itemId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!item) throw notFound();
    const v = await this.d.db
      .selectFrom("catalog_item_versions")
      .select("extension_sha256")
      .where("item_id", "=", itemId)
      .where("version", "=", version)
      .executeTakeFirst();
    if (!v) {
      throw new ApiError("catalog.item_not_found", `Version ${version} of this item not found`);
    }
    if (v.extension_sha256 === null) {
      throw new ApiError(
        "catalog.no_extension",
        `Plugin ${item.name} ${version} has no extension; there is nothing to install on the deployment`,
      );
    }
    return this.d.ops.install(item.name, v.extension_sha256, actor, opts.actorTokenId, {
      catalogItemId: itemId,
    });
  }

  private async view(itemId: string): Promise<CatalogItemView> {
    return (await this.get(itemId)).item;
  }
}

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
  packageName: string;
  version: string;
  /** The normalized plugin.json. */
  manifest: PluginManifest;
  listing: CatalogListing;
  /** The id of the item to create when there is none yet (the one the storage prefix used). */
  newItemId: string;
  source: { source: "file" | "npm" | "marketplace"; ref: string; integrity?: string };
  /** Imported from a marketplace: the item records it. */
  marketplaceId?: string;
  objectPrefix: string | null;
  extensionSha256: string | null;
  files: { path: string; size: number; sha256: string }[];
  size: number;
  /** Merged into the detail of the `catalog.imported` audit. */
  auditDetail?: Record<string, unknown>;
}

/** Takes the transaction-level advisory lock of an item name (concurrent imports of it serialize). */
export async function lockCatalogName(trx: Trx, name: string): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtext(${`capybara.directory-item:${name}`}))`.execute(
    trx,
  );
}

function liveItem(db: KernelDb | Trx, name: string) {
  return db
    .selectFrom("catalog_items")
    .select(["id", "package_name", "latest_version"])
    .where("name", "=", name)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
}

async function hasVersion(db: KernelDb | Trx, itemId: string, version: string): Promise<boolean> {
  const row = await db
    .selectFrom("catalog_item_versions")
    .select("version")
    .where("item_id", "=", itemId)
    .where("version", "=", version)
    .executeTakeFirst();
  return row !== undefined;
}

/**
 * Conflict precheck before writing (no lock; {@link writeCatalogVersion}'s re-check inside the
 * transaction is final): an item with the same name from another npm package ->
 * `catalog.name_conflict`; version already imported -> `catalog.version_exists`. Returns the
 * existing item (undefined when there is none).
 */
export async function precheckCatalogImport(
  db: KernelDb,
  name: string,
  packageName: string,
  version: string,
): Promise<{ id: string } | undefined> {
  const existing = await liveItem(db, name);
  if (existing) {
    assertImportable(existing, packageName, version, await hasVersion(db, existing.id, version));
  }
  return existing;
}

/**
 * Writes a catalog version in the caller's transaction (the caller has re-checked the enterprise
 * admin): takes the name's advisory lock, checks conflicts again, creates the item when there is
 * none or adds the version (latest and display fields change only for a higher version), and writes
 * the version row and the `catalog.imported` audit. Returns the item id.
 */
export async function writeCatalogVersion(trx: Trx, w: CatalogVersionWrite): Promise<string> {
  const { name, version, listing } = w;
  await lockCatalogName(trx, name);
  const live = await liveItem(trx, name);
  let id: string;
  if (live) {
    id = live.id;
    assertImportable(live, w.packageName, version, await hasVersion(trx, id, version));
    const newer = semver.gt(version, live.latest_version);
    await trx
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
    await trx
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
  await trx
    .insertInto("catalog_item_versions")
    .values({
      item_id: id,
      version,
      manifest: JSON.stringify(w.manifest),
      source: w.source.source,
      source_ref: w.source.ref,
      integrity: w.source.integrity ?? null,
      object_prefix: w.objectPrefix,
      extension_sha256: w.extensionSha256,
      files: JSON.stringify(w.files.map(({ path, size, sha256 }) => ({ path, size, sha256 }))),
      size: w.size,
      imported_by: w.actor,
    })
    .execute();
  await audit(trx, {
    ...(w.actor !== null && { actorAccountId: w.actor }),
    ...(w.actorTokenId !== undefined && { actorTokenId: w.actorTokenId }),
    action: "catalog.imported",
    target: id,
    detail: {
      name,
      version,
      source: w.source.source,
      sourceRef: w.source.ref,
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
  db: KernelDb | Trx,
  name: string,
  packageName: string,
): Promise<void> {
  const owner = await db
    .selectFrom("extension_name_owners")
    .select("package_name")
    .where("name", "=", name)
    .executeTakeFirst();
  if (owner && owner.package_name !== packageName) {
    throw new ApiError(
      "extension.name_conflict",
      `Extension name ${name} belongs to package ${owner.package_name}; package ${packageName} cannot use it`,
    );
  }
}

/** Whether a package may add a version to an existing item: the same npm package, a new version. */
function assertImportable(
  item: { package_name: string },
  packageName: string,
  version: string,
  versionExists: boolean,
): void {
  if (item.package_name !== packageName) {
    throw new ApiError(
      "catalog.name_conflict",
      `A catalog item with this name comes from package ${item.package_name}; package ${packageName} cannot add versions to it`,
    );
  }
  if (versionExists) {
    throw new ApiError(
      "catalog.version_exists",
      `Version ${version} of this catalog item has already been imported`,
    );
  }
}

/**
 * The highest compatible version of a marketplace-imported item in its marketplace (when enabled)
 * (see {@link CatalogItemView.latestMarketplaceVersion}).
 */
async function marketplaceLatest(
  db: KernelDb,
  config: KernelConfig,
  items: { id: string; name: string; marketplace_id?: string | null }[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const sourced = items.filter((i) => typeof i.marketplace_id === "string");
  if (sourced.length === 0) return out;
  const rows = await db
    .selectFrom("marketplace_entries as e")
    .innerJoin("marketplaces as s", "s.id", "e.source_id")
    .select(["e.source_id", "e.name", "e.version", "e.entry", "s.builtin", "s.enabled"])
    .where("e.source_id", "in", [...new Set(sourced.map((i) => i.marketplace_id as string))])
    .where("e.name", "in", [...new Set(sourced.map((i) => i.name))])
    .execute();
  for (const i of sourced) {
    const [best] = rows
      .filter(
        (r) =>
          r.source_id === i.marketplace_id &&
          r.name === i.name &&
          r.version !== "" &&
          sourceEffective(r, config) &&
          entryCompatible(r.entry as MarketplaceEntry),
      )
      .map((r) => r.version)
      .sort(bySemverDesc);
    if (best !== undefined) out.set(i.id, best);
  }
  return out;
}

/** Org install counts per item (see {@link CatalogItemView.installs}). */
async function countInstalls(
  db: KernelDb,
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
    .where("status", "=", "installed")
    .execute();
  for (const r of installed) orgs.get(r.item_id)?.add(r.org_id);
  const withExtension = items.filter(
    (i) =>
      (versions.get(i.id) ?? []).find((v) => v.version === i.latest_version)?.extension_sha256 !=
      null,
  );
  if (withExtension.length > 0) {
    const enabled = await db
      .selectFrom("extension_org_configs")
      .select(["plugin", "org_id"])
      .where(
        "plugin",
        "in",
        withExtension.map((p) => p.name),
      )
      .where("enabled", "=", true)
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
  versions: { version: string; source: string }[],
  installs = 0,
  latestMarketplaceVersion: string | null = null,
): CatalogItemView {
  const sorted = [...versions].sort((a, b) => bySemverDesc(a.version, b.version));
  const top = sorted[0]?.version ?? i.latest_version;
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
      latestMarketplaceVersion !== null && semver.gt(latestMarketplaceVersion, top),
    updatedAt: i.updated_at.toISOString(),
  };
}
