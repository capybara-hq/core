import {
  isSafePackagePath,
  type LocalizedName,
  marketplaceEntryVersion,
  type PluginManifest,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import type { KernelSchemaDb, SourceFormat } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { ExtensionAdminOps } from "../extensions/admin-ops.js";
import { ExtensionInstalls } from "../extensions/installs.js";
import type { AdminExtensionView } from "../extensions/permission-view.js";
import { audit } from "../identity/audit.js";
import { EnterpriseAdminLock } from "../identity/enterprise-admin.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { sameRepository } from "../packages/provenance.js";
import { countInstalls, itemView, marketplaceLatest } from "./catalog-items.js";
import type { TranslationReport } from "./claude/report.js";
import {
  expandGitUrl,
  type GitLocation,
  type GitOptions,
  GitSourceError,
  gitErrorDetails,
  normalGitPath,
  readGitTreeAndOids,
  resolveGitCommit,
} from "./git-source.js";
import {
  fetchMarketplaceArchive,
  marketplaceNetPolicy,
  marketplaceUrlProblem,
} from "./marketplace-fetch.js";
import {
  entryCompatible,
  entrySourceHost,
  HOST_VERSIONS,
  hostAllowed,
  loadMarketplaceEntry,
  MarketplacesService,
  pluginNameFrom,
} from "./marketplaces.service.js";
import { PluginImport, type PluginReview, type ReviewProvenance } from "./plugin-import.js";
import { cancelPendingRequests } from "./requests.service.js";
import { newestFirst } from "./versions.js";

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
export type CatalogVersionSource = "file" | "npm" | "marketplace" | "git" | "bootstrap";

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
  /** `claude-code`: translated from a Claude Code plugin. */
  sourceFormat: SourceFormat;
  /** The translation report of a Claude Code plugin (null for a native plugin). */
  translation: TranslationReport | null;
  /** The root LICENSE text (null without one, or before phase B). */
  licenseText: string | null;
  /** The root LICENSE was longer than 64 KiB (or not UTF-8), so `licenseText` is null. */
  licenseTruncated: boolean;
  importedBy: string | null;
  importedAt: string;
}

/** Item detail (deleted items included: `deletedAt` set). */
export interface CatalogItemDetail {
  /** `packageName` is null for a git plugin without package.json. */
  item: CatalogItemView & { packageName: string | null; deletedAt: string | null };
  versions: CatalogItemVersionView[];
}

/** Audits carry the PAT when a personal token made the call. */
export interface ActorOpts {
  actorTokenId?: string;
}

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

/**
 * A git read failure as an API error (the network rule's code when net/ refused), with details
 * naming the host, repo, ref or commit and refused entry ({@link gitErrorDetails}).
 */
function gitApiError(e: unknown, loc: GitLocation): unknown {
  if (!(e instanceof GitSourceError)) return e;
  return new ApiError(e.netCode ?? e.code, e.message, [gitErrorDetails(e, loc)]);
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

/** Default / largest page size of the list. */
export const CATALOG_LIST_DEFAULT_LIMIT = 200;
export const CATALOG_LIST_MAX_LIMIT = 1000;

/**
 * Enterprise catalog items (D9 / C21 / C22, `/api/v1/admin/catalog/*`, enterprise admins only). One
 * kind: every item is a plugin (spec §4), imported through {@link PluginImport} (prepare -> confirm,
 * one review); this service lists and shows items, changes policy, deletes, installs an item's
 * extension on the deployment, and prepares marketplace imports. Stateless, shared by every replica.
 */
@Injectable()
export class CatalogService {
  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    /** The enterprise admin lock (identity/enterprise-admin.ts; R12): joins the caller's transaction. */
    @Inject(EnterpriseAdminLock) private readonly adminLock: EnterpriseAdminLock,
    @Inject(KernelConfigService) private readonly config: KernelConfigService,
    @Inject(ExtensionInstalls) private readonly installs: ExtensionInstalls,
    @Inject(ExtensionAdminOps) private readonly ops: ExtensionAdminOps,
    /** Plugin import (a marketplace entry goes through its prepare). */
    @Inject(PluginImport) private readonly pluginImport: PluginImport,
    /** The token of an enterprise marketplace (sent only to its URL's origin). */
    @Inject(MarketplacesService) private readonly marketplaces: MarketplacesService,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
  ) {}

  /** The kernel-schema handle of the current context (the transaction, else the pool). */
  private get db(): KernelSchemaDb {
    return this.kdb.db;
  }

  /** Downloads a marketplace archive source, verified against its integrity. */
  private fetchArchive(
    archive: { url: string; integrity: string },
    signal?: AbortSignal,
  ): Promise<{ bytes: Uint8Array; integrity: string }> {
    const config = this.config.get();
    return fetchMarketplaceArchive(archive, {
      maxBytes: config.packages.maxBytes,
      timeoutMs: 120_000,
      net: marketplaceNetPolicy(config),
      ...(signal !== undefined && { signal }),
    });
  }

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
    const config = this.config.get();
    const { entry, marketplace, claude } = await loadMarketplaceEntry(
      this.db,
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
        [{ host, entry: entry.name }],
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
      let provenance: ReviewProvenance | undefined;
      if ("npm" in src) {
        got = await this.installs.fetchMarketplacePackage(
          { package: src.npm.package, version: src.npm.version, integrity: src.npm.integrity },
          opts.signal,
        );
        ref = `${input.marketplaceId}:${src.npm.package}@${src.npm.version}`;
        detail = { registry: new URL(config.packages.npmRegistry).origin };
        const p = await this.installs.fetchProvenance(
          { package: src.npm.package, version: src.npm.version, integrity: got.integrity },
          opts.signal,
        );
        // a git marketplace declares its repository: an attestation from another one is a warning
        const mismatch =
          p.checked && marketplace.form === "git" && !sameRepository(p.repository, marketplace.url);
        provenance = { provenance: p, ...(mismatch && { warning: "repository_mismatch" }) };
      } else {
        got = await this.fetchArchive(src.archive, opts.signal);
        ref = `${input.marketplaceId}:${archiveRef(src.archive.url)}`;
        detail = { url: archiveRef(src.archive.url) };
      }
      staged = await this.pluginImport.prepare(
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
          ...(provenance !== undefined && { provenance }),
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
            [{ entry: entry.name, path: src.path }],
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
        : await this.marketplaces.token(input.marketplaceId);
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
      staged = await this.pluginImport.prepareGit(
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
            ...(entry.version !== undefined && { entryVersion: entry.version }),
          },
          ...(claude !== undefined && { claude }),
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
    actor: string | null,
    input: { url: string; ref?: string; path?: string },
    opts: ActorOpts & { signal?: AbortSignal } = {},
  ): Promise<{ stagingId: string; review: PluginReview }> {
    const url = expandGitUrl(input.url);
    const problem = marketplaceUrlProblem(
      url,
      this.config.get().marketplaces.allowInsecureLoopback,
    );
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
    const r = await this.pluginImport.prepareGit(
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
    const config = this.config.get();
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
      throw gitApiError(e, loc);
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
    let query = this.db
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
    const versions = await this.db
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
    const installs = await countInstalls(this.db, items, byItem);
    const latest = await marketplaceLatest(this.db, this.config.get(), items, byItem);
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
    const item = await this.db
      .selectFrom("catalog_items")
      .selectAll()
      .where("id", "=", itemId)
      .executeTakeFirst();
    if (!item) throw notFound();
    const rows = await this.db
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
    const installs = await countInstalls(this.db, [item], byItem);
    const latest = await marketplaceLatest(this.db, this.config.get(), [item], byItem);
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
        sourceFormat: v.source_format,
        translation: (v.translation as TranslationReport | null) ?? null,
        licenseText: v.license_text,
        licenseTruncated: v.license_truncated,
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
    await this.writePolicy(actor, itemId, policy, opts);
    return this.view(itemId);
  }

  @Transactional()
  private async writePolicy(
    actor: string,
    itemId: string,
    policy: CatalogPolicy,
    opts: ActorOpts,
  ): Promise<void> {
    const t = this.db;
    await this.adminLock.lockAndAuthorize(actor);
    const row = await t
      .selectFrom("catalog_items")
      .select(["name", "policy"])
      .where("id", "=", itemId)
      .where("deleted_at", "is", null)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw notFound();
    if (row.policy === policy) return;
    await t
      .updateTable("catalog_items")
      .set({ policy, updated_at: sql<Date>`now()` as unknown as Date })
      .where("id", "=", itemId)
      .execute();
    await audit(t, {
      actorAccountId: actor,
      ...(opts.actorTokenId !== undefined && { actorTokenId: opts.actorTokenId }),
      action: "catalog.policy_changed",
      target: itemId,
      detail: { name: row.name, from: row.policy, to: policy },
    });
  }

  /**
   * Deletes the item (soft delete, audit `catalog.removed`; requests still pending are cancelled in
   * the same transaction): versions and stored files are kept (installed components still refer to
   * them), organizations no longer see it; the same name can later be imported again as a new
   * item. Deleted / missing -> `catalog.item_not_found`.
   */
  async remove(actor: string, itemId: string, opts: ActorOpts = {}): Promise<void> {
    if (!UUID_RE.test(itemId)) throw notFound();
    await this.writeRemove(actor, itemId, opts);
  }

  @Transactional()
  private async writeRemove(actor: string, itemId: string, opts: ActorOpts): Promise<void> {
    const t = this.db;
    await this.adminLock.lockAndAuthorize(actor);
    const row = await t
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
    await cancelPendingRequests(t, { itemId }, actor, "item_removed", opts);
    await audit(t, {
      actorAccountId: actor,
      ...(opts.actorTokenId !== undefined && { actorTokenId: opts.actorTokenId }),
      action: "catalog.removed",
      target: itemId,
      detail: { name: row.name },
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
    const item = await this.db
      .selectFrom("catalog_items")
      .select(["id", "name"])
      .where("id", "=", itemId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!item) throw notFound();
    const v = await this.db
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
    return this.ops.install(item.name, v.extension_sha256, actor, opts.actorTokenId, {
      catalogItemId: itemId,
    });
  }

  private async view(itemId: string): Promise<CatalogItemView> {
    return (await this.get(itemId)).item;
  }
}
