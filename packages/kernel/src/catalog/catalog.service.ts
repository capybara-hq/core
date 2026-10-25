import {
  type Connector,
  type ConnectorTemplateSpec,
  isSafePackagePath,
  type LocalizedName,
  type MarketplaceEntry,
  marketplaceEntryVersion,
  type PluginManifest,
} from "@capybara-hq/plugin-sdk";
import { sql, type Transaction } from "kysely";
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
  expandGitUrl,
  type GitLocation,
  type GitOptions,
  GitSourceError,
  gitLocationIdentity,
  normalGitPath,
  readGitTreeAndOids,
  resolveGitCommit,
} from "./git-source.js";
import { marketplaceNetPolicy, marketplaceUrlProblem } from "./marketplace-fetch.js";
import {
  entryCompatible,
  entryContentChanged,
  entrySourceHost,
  HOST_VERSIONS,
  hostAllowed,
  type ImportedAs,
  loadMarketplaceEntry,
  pluginNameFrom,
  sourceEffective,
} from "./marketplaces.service.js";
import type { PluginImport, PluginReview } from "./plugin-import.js";
import { cancelPendingRequests } from "./requests.service.js";
import { schemaHasPath } from "./schema-path.js";
import { compareVersions, newestFirst, sameRelease, withBuild } from "./versions.js";

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
  /** Every version, newest first (semver; equal but for build metadata: the later import first). */
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
  /**
   * An entry of its marketplace has a version already imported, but its source now differs from
   * what was recorded (another commit or integrity): "content changed at the same version" (spec
   * §5.3). Importing it again records `<version>+git.<sha12>` / `+sha256.<12>`.
   */
  contentChanged: boolean;
  updatedAt: string;
}

/**
 * A git source as recorded (spec §5.1: the actual host, repo and commit, and whether it follows a
 * branch, i.e. no commit was pinned). `path` is `.` for the repo root.
 */
export interface GitSourceDetail {
  host: string;
  repo: string;
  path: string;
  ref?: string;
  commit: string;
  followsBranch: boolean;
  /**
   * The git tree oid of the plugin's directory at `commit` (equal oids, equal files: a monorepo
   * commit that leaves the directory alone keeps it). Absent before phase A1 task 4's fix round.
   */
  tree?: string;
}

/** Where a catalog version came from: a git location, an archive URL (origin + path), an npm registry. */
export type SourceDetail = GitSourceDetail | { url: string } | { registry: string };

/** The source kinds of a catalog version. */
export type CatalogVersionSource = "file" | "npm" | "marketplace" | "git";

/** One version of an item. */
export interface CatalogItemVersionView {
  version: string;
  source: CatalogVersionSource;
  sourceRef: string;
  integrity: string | null;
  /** The content digest of the imported files (null for a version imported before phase A1). */
  contentDigest: string | null;
  /** Where it came from (null for an upload, or a version imported before phase A1). */
  sourceDetail: SourceDetail | null;
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
  /** `packageName` is null for a git plugin without package.json. */
  item: CatalogItemView & { packageName: string | null; deletedAt: string | null };
  versions: CatalogItemVersionView[];
}

export interface CatalogServiceDeps {
  db: KernelDb;
  config: () => KernelConfig;
  installs: Pick<ExtensionInstalls, "fetchMarketplacePackage">;
  ops: Pick<ExtensionAdminOps, "install">;
  /** Plugin import (a marketplace entry goes through its prepare). */
  pluginImport: Pick<PluginImport, "prepare" | "prepareGit">;
  /** The token of an enterprise marketplace (sent only to its URL's origin). */
  marketplaceToken: (marketplaceId: string) => Promise<string | undefined>;
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

/** A git read failure as an API error (the network rule's code when net/ refused). */
function gitApiError(e: unknown): unknown {
  if (!(e instanceof GitSourceError)) return e;
  return new ApiError(e.netCode ?? e.code, e.message);
}

/** `<host>/<owner>` of a repo URL (the publisher of a skills-only plugin without a marketplace owner). */
export function repoOwner(url: string): string {
  const u = new URL(url);
  const segs = u.pathname.split("/").filter((s) => s !== "");
  return segs.length > 1 ? `${u.host}/${segs[0]}` : u.host;
}

/**
 * The version of a git plugin that has none (spec §5.3): `0.0.0-git.g<sha12>`. The `g` keeps the
 * prerelease identifier alphanumeric: twelve hex characters that happen to be all digits with a
 * leading zero are not valid semver.
 */
export const gitFallbackVersion = (commit: string): string => `0.0.0-git.g${commit.slice(0, 12)}`;

/** The recorded git location and the `source_ref` text of a git import. */
function gitSource(
  loc: GitLocation,
  read: { commit: string; tree: string | undefined },
  pinned: boolean,
): { detail: GitSourceDetail; ref: string } {
  const commit = read.commit;
  const u = new URL(loc.url);
  const path = normalGitPath(loc.path);
  return {
    detail: {
      host: u.host,
      repo: u.pathname.replace(/^\/+/, ""),
      path,
      ...(loc.ref !== undefined && !pinned && { ref: loc.ref }),
      commit,
      followsBranch: !pinned,
      ...(read.tree !== undefined && { tree: read.tree }),
    },
    ref: `${u.origin}${u.pathname}@${commit}${path === "." ? "" : `:${path}`}`,
  };
}

/**
 * The object storage prefix of one import (relative to `deployment/`):
 * `directory/<itemId>/<version>/<importId>/`. Each import gets a new `importId`, so the losing one of
 * two concurrent imports of the same version never overwrites the committed version's files; reads
 * always go through the `object_prefix` stored on the version row. Build metadata's `+` is written
 * as `_` (a `+` in a key can turn into a space through URL query encoding).
 */
export const catalogObjectPrefix = (itemId: string, version: string, importId: string) =>
  `directory/${itemId}/${version.replace(/\+/g, "_")}/${importId}/`;

/** Default / largest page size of the list. */
export const CATALOG_LIST_DEFAULT_LIMIT = 200;
export const CATALOG_LIST_MAX_LIMIT = 1000;

const PUT_CONCURRENCY = 8;

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
   * (`marketplace.integrity_mismatch`, nothing written). A `path` source is read from the git
   * marketplace's repository at its last refreshed commit (an http marketplace has none:
   * `marketplace.path_unsupported`); a `git` source at its pinned `commit`, else at its `ref`'s head
   * now, recorded; both through {@link PluginImport.prepareGit} with source `git` and
   * `source_detail` (host, repo, path, ref, commit, followsBranch). A git / archive host outside
   * `marketplaces.allowedHosts` -> `marketplace.host_not_allowed`. The marketplace token goes only
   * to the marketplace URL's origin. The package must match the entry (name, version, npm package:
   * `marketplace.package_mismatch`), then the same review as any plugin import
   * ({@link PluginImport.prepare}) with source `marketplace` (ref `<marketplaceId>:<npm>@<version>`
   * or `<marketplaceId>:<archive URL>`; git: `<marketplaceId>:<repo>@<commit>[:<path>]`), confirmed with
   * `POST /api/v1/admin/catalog/imports/:stagingId/confirm`. Marketplace missing ->
   * `marketplace.not_found`; disabled, or the entry / version missing -> `marketplace.entry_not_found`.
   */
  async importFromMarketplace(
    actor: string,
    input: { marketplaceId: string; name: string; version?: string },
    opts: ActorOpts & { signal?: AbortSignal } = {},
  ): Promise<MarketplaceImportResult> {
    const config = this.d.config();
    const { entry, marketplace } = await loadMarketplaceEntry(
      this.d.db,
      config,
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
    const host = entrySourceHost(entry);
    if (host !== undefined && !hostAllowed(host, config)) {
      throw new ApiError(
        "marketplace.host_not_allowed",
        `Marketplace entry ${entry.name} downloads from ${host}, which is not in marketplaces.allowedHosts`,
      );
    }
    const prepareOpts = {
      ...(opts.actorTokenId !== undefined && { actorTokenId: opts.actorTokenId }),
      expect: {
        marketplace: {
          name: entry.name,
          version,
          ...("npm" in src && { packageName: src.npm.package }),
          ...(entry.permissions !== undefined && { permissions: entry.permissions.keys }),
        },
      },
    };
    let staged: Awaited<ReturnType<PluginImport["prepare"]>>;
    if ("npm" in src || "archive" in src) {
      let got: { bytes: Uint8Array; integrity: string };
      let ref: string;
      let detail: SourceDetail;
      if ("npm" in src) {
        got = await this.d.installs.fetchMarketplacePackage(
          { package: src.npm.package, version: src.npm.version, integrity: src.npm.integrity },
          opts.signal,
        );
        ref = `${input.marketplaceId}:${src.npm.package}@${src.npm.version}`;
        detail = { registry: new URL(config.packages.npmRegistry).origin };
      } else {
        got = await this.d.fetchArchive(src.archive, opts.signal);
        ref = `${input.marketplaceId}:${archiveRef(src.archive.url)}`;
        detail = { url: archiveRef(src.archive.url) };
      }
      staged = await this.d.pluginImport.prepare(
        actor,
        got.bytes,
        {
          kind: "marketplace",
          ref,
          integrity: got.integrity,
          marketplaceId: input.marketplaceId,
          detail,
        },
        {
          ...prepareOpts,
          // an archive without plugin.json may be skills only (named by the entry, spec §5.3)
          ...("archive" in src && {
            fallback: {
              name: entry.name,
              ...(entry.version !== undefined && { version: entry.version }),
              publisher: marketplace.ownerName ?? new URL(src.archive.url).host,
            },
          }),
        },
      );
    } else {
      // path: the marketplace's own repo at its last refresh; git: the entry's repo
      let loc: GitLocation;
      if ("path" in src) {
        if (marketplace.form !== "git") {
          throw new ApiError(
            "marketplace.path_unsupported",
            `Marketplace entry ${entry.name} is a path in the marketplace's repository, but this marketplace is fetched over http; add the repository as a git marketplace`,
          );
        }
        if (marketplace.lastCommit === null) {
          // the URL or ref changed after the entries were read: their commit is unknown
          throw new ApiError(
            "conflict",
            "The marketplace's repository or ref changed since its last refresh; refresh it before importing",
          );
        }
        loc = { url: marketplace.url, commit: marketplace.lastCommit, path: src.path };
      } else {
        loc = {
          url: src.git.url,
          ...(src.git.ref !== undefined && { ref: src.git.ref }),
          ...(src.git.commit !== undefined && { commit: src.git.commit }),
          ...(src.git.path !== undefined && { path: src.git.path }),
        };
      }
      const token = marketplace.builtin
        ? undefined
        : await this.d.marketplaceToken(input.marketplaceId);
      const read = await this.readGit(loc, {
        ...(token !== undefined && { token, tokenOrigin: new URL(marketplace.url).origin }),
        ...(opts.signal !== undefined && { signal: opts.signal }),
      });
      // path entries follow the marketplace's ref; git entries follow theirs unless a commit is pinned
      const pinned = "git" in src && src.git.commit !== undefined;
      const where = gitSource(
        "path" in src && marketplace.ref !== null ? { ...loc, ref: marketplace.ref } : loc,
        read,
        pinned,
      );
      staged = await this.d.pluginImport.prepareGit(
        actor,
        read.files,
        {
          kind: "git",
          ref: `${input.marketplaceId}:${where.ref}`,
          marketplaceId: input.marketplaceId,
          detail: where.detail,
        },
        {
          ...prepareOpts,
          fallback: {
            name: entry.name,
            version: entry.version ?? gitFallbackVersion(read.commit),
            publisher: marketplace.ownerName ?? repoOwner(loc.url),
          },
        },
      );
    }
    return {
      stagingId: staged.stagingId,
      review: staged.review,
      permissionsMismatch: staged.permissionsMismatch,
    };
  }

  /**
   * Prepares the import of one plugin straight from git (spec §5.1, a one-off like an upload: no
   * marketplace is created and no updates are tracked): `url` is an https git URL or `owner/repo`
   * (GitHub), `ref` a branch / tag / commit (default the remote HEAD), `path` the plugin's directory
   * (default the root). The commit is resolved and recorded (`source_detail`), then the same review
   * as any plugin import. A skills-only directory without plugin.json is named after the last
   * segment of `path` (else of the repo URL) and published by the repo owner.
   */
  async importFromGit(
    actor: string,
    input: { url: string; ref?: string; path?: string },
    opts: ActorOpts & { signal?: AbortSignal } = {},
  ): Promise<{ stagingId: string; review: PluginReview }> {
    const url = expandGitUrl(input.url);
    const problem = marketplaceUrlProblem(url, this.d.config().marketplaces.allowInsecureLoopback);
    if (problem !== null) throw new ApiError("validation_failed", `url: ${problem}`);
    if (input.path !== undefined) {
      const p = normalGitPath(input.path);
      if (input.path.startsWith("/") || (p !== "." && !isSafePackagePath(p))) {
        throw new ApiError(
          "validation_failed",
          `path: "${input.path}" must be . or a relative path inside the repository`,
        );
      }
    }
    const loc: GitLocation = {
      url,
      ...(input.ref !== undefined && { ref: input.ref }),
      ...(input.path !== undefined && { path: input.path }),
    };
    const read = await this.readGit(loc, opts.signal !== undefined ? { signal: opts.signal } : {});
    const pinned = input.ref !== undefined && /^[0-9a-f]{40}$/i.test(input.ref);
    const where = gitSource(loc, read, pinned);
    const segment =
      where.detail.path === "."
        ? (new URL(url).pathname
            .split("/")
            .filter((s) => s !== "")
            .pop() ?? "plugin")
        : (where.detail.path.split("/").pop() as string);
    const r = await this.d.pluginImport.prepareGit(
      actor,
      read.files,
      { kind: "git", ref: where.ref, detail: where.detail },
      {
        ...(opts.actorTokenId !== undefined && { actorTokenId: opts.actorTokenId }),
        fallback: {
          name: pluginNameFrom(segment),
          version: gitFallbackVersion(read.commit),
          publisher: repoOwner(url),
        },
      },
    );
    return { stagingId: r.stagingId, review: r.review };
  }

  /** Resolves the commit and reads the plugin's files; git failures become API errors. */
  private async readGit(
    loc: GitLocation,
    o: Pick<GitOptions, "token" | "tokenOrigin"> & { signal?: AbortSignal },
  ): Promise<{ commit: string; files: Map<string, Uint8Array>; tree: string | undefined }> {
    const config = this.d.config();
    const options: GitOptions = {
      net: marketplaceNetPolicy(config),
      maxBytes: config.packages.maxBytes,
      signal: o.signal ?? new AbortController().signal,
      ...(o.token !== undefined && { token: o.token }),
      ...(o.tokenOrigin !== undefined && { tokenOrigin: o.tokenOrigin }),
    };
    try {
      const commit = await resolveGitCommit(loc, options);
      const dir = normalGitPath(loc.path);
      const read = await readGitTreeAndOids({ ...loc, commit }, { ...options, trees: () => [dir] });
      return { commit, files: read.files, tree: read.trees.get(dir) };
    } catch (e) {
      throw gitApiError(e);
    }
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
      .select([
        "item_id",
        "version",
        "source",
        "source_ref",
        "extension_sha256",
        "integrity",
        "source_detail",
        "imported_at",
      ])
      .where(
        "item_id",
        "in",
        items.map((i) => i.id),
      )
      .execute();
    const byItem = new Map<string, (typeof versions)[number][]>();
    for (const v of versions) {
      const list = byItem.get(v.item_id) ?? [];
      list.push(v);
      byItem.set(v.item_id, list);
    }
    const installs = await countInstalls(this.d.db, items, byItem);
    const latest = await marketplaceLatest(this.d.db, this.d.config(), items, byItem);
    return {
      items: items.map((i) =>
        itemView(i, byItem.get(i.id) ?? [], installs.get(i.id) ?? 0, latest.get(i.id)),
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
    rows.sort((a, b) =>
      newestFirst(
        { version: a.version, importedAt: a.imported_at },
        { version: b.version, importedAt: b.imported_at },
      ),
    );
    const byItem = new Map([[item.id, rows]]);
    const installs = await countInstalls(this.d.db, [item], byItem);
    const latest = await marketplaceLatest(this.d.db, this.d.config(), [item], byItem);
    return {
      item: {
        ...itemView(item, rows, installs.get(item.id) ?? 0, latest.get(item.id)),
        packageName: item.package_name,
        deletedAt: item.deleted_at?.toISOString() ?? null,
      },
      versions: rows.map((v) => ({
        version: v.version,
        source: v.source,
        sourceRef: v.source_ref,
        integrity: v.integrity,
        contentDigest: v.content_digest,
        sourceDetail: (v.source_detail as SourceDetail | null) ?? null,
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
  /** Merged into the detail of the `catalog.imported` audit. */
  auditDetail?: Record<string, unknown>;
}

/** Takes the transaction-level advisory lock of an item name (concurrent imports of it serialize). */
export async function lockCatalogName(trx: Trx, name: string): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtext(${`capybara.directory-item:${name}`}))`.execute(
    trx,
  );
}

/**
 * The live item of a name, with the source identity of its latest version
 * ({@link sourceIdentity}; null when there is none).
 */
async function liveItem(db: KernelDb | Trx, name: string) {
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
async function itemVersions(db: KernelDb | Trx, itemId: string) {
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
 * source, the digest's first 12 hex), never overwriting the imported version.
 */
export function recordedVersion(existing: ExistingVersion[], p: ImportIdentity): string {
  assertNewContent(existing, p);
  if (!existing.some((v) => v.version === p.version)) return p.version;
  const d = p.detail;
  const build =
    d !== undefined && "commit" in d
      ? `git.${d.commit.slice(0, 12)}`
      : `sha256.${p.contentDigest.slice(0, 12)}`;
  const next = withBuild(p.version, build);
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
  db: KernelDb,
  name: string,
  p: ImportIdentity,
): Promise<{ existing: { id: string } | undefined; version: string }> {
  const existing = await liveItem(db, name);
  if (!existing) return { existing, version: p.version };
  assertSameSource(existing, p.packageName, sourceIdentity(p.detail, p.marketplaceId));
  return { existing, version: recordedVersion(await itemVersions(db, existing.id), p) };
}

/**
 * Writes a catalog version in the caller's transaction (the caller has re-checked the enterprise
 * admin): takes the name's advisory lock, checks conflicts again (the same source; no version of
 * the release with the same content; `version` not taken meanwhile), creates the item when there is
 * none or adds the version (latest and display fields change only for a newer version, a version
 * equal but for build metadata being newer as the later import), and writes the version row (with
 * its content digest) and the `catalog.imported` audit. Returns the item id.
 */
export async function writeCatalogVersion(trx: Trx, w: CatalogVersionWrite): Promise<string> {
  const { name, version, listing } = w;
  await lockCatalogName(trx, name);
  const live = await liveItem(trx, name);
  let id: string;
  if (live) {
    id = live.id;
    assertSameSource(live, w.packageName, sourceIdentity(w.source.detail, w.marketplaceId));
    const existing = await itemVersions(trx, id);
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
      source_detail: w.source.detail !== undefined ? JSON.stringify(w.source.detail) : null,
      content_digest: w.contentDigest,
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
  db: KernelDb | Trx,
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
async function marketplaceLatest(
  db: KernelDb,
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
