import { createHash, randomUUID } from "node:crypto";
import {
  type Connector,
  type ConnectorTemplateSpec,
  type LocalizedName,
  type Logger,
  type PluginManifest,
  parseSkillMd,
  SDK_VERSION,
  SKILL_ENTRY_FILE,
} from "@capybara-hq/plugin-sdk";
import { sql, type Transaction } from "kysely";
import semver from "semver";
import type { KernelConfig } from "../config/schema.js";
import type { KernelDatabase, KernelDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import type { ExtensionAdminOps } from "../extensions/admin-ops.js";
import { writeSnapshot } from "../extensions/approvals.js";
import type { ExtensionInstalls } from "../extensions/installs.js";
import { unrunMigrations } from "../extensions/migrate-lock.js";
import {
  type ExtensionPackage,
  ExtensionPackageError,
  permissionSetOfPackage,
  readExtensionPackage,
} from "../extensions/package.js";
import {
  diffPermissions,
  type PermissionSet,
  permissionKeys,
  WARNINGS_KEY_PREFIX,
} from "../extensions/permission-set.js";
import {
  reviewHash as extensionReviewHash,
  migrationWarnings,
  type PackageWarning,
  type PermissionGroup,
  type PermissionItem,
  permissionGroups,
  permissionKeyItems,
} from "../extensions/permission-view.js";
import type { ExtensionSource } from "../extensions/sources.js";
import { audit } from "../identity/audit.js";
import { lockEnterpriseAdminsAndAuthorize } from "../identity/enterprise-admin.js";
import { checkSkillFiles, SkillArchiveError, type SkillPackageFile } from "../skills/package.js";
import type { StorageService } from "../storage/storage.service.js";
import { endpointCredentialIssues } from "../tools/endpoint.js";
import {
  type ActorOpts,
  assertPluginNameOwner,
  type CatalogItemView,
  catalogObjectPrefix,
  itemView,
  type PermissionsMismatch,
  permissionsMismatch,
  precheckCatalogImport,
  putCatalogFiles,
  templateProblems,
  writeCatalogVersion,
} from "./catalog.service.js";
import {
  type PluginPackage,
  PluginPackageError,
  packagePath,
  readPluginPackage,
} from "./plugin-package.js";

/**
 * Enterprise import of a plugin (package ecosystem spec §4.3): one review for every plugin, whatever
 * it contains (an extension, skills, connector templates, dependencies), confirmed once.
 *
 * prepare: the tgz is always hostile input, and **nothing is written until every check passes**
 * (F-AD): `readPluginPackage` (plugin.json, package.json, listed / scanned skills and templates,
 * icons; a pre-0.1.0 tgz is `catalog.legacy_format`), the extension's module graph and migrations
 * (`readExtensionPackage`), the extension's deployment state (builtin / config-declared names are
 * refused; name ownership; a downgrade to a version with unrun migrations is refused), each skill by
 * the skill package rules, each connector template against the connector loaded on this replica (or
 * statically when the connector is provided by the plugin's own extension or by a dependency), the
 * catalog name / version conflicts and the actor still an enterprise admin. Dependencies are only
 * resolved against the imported catalog versions for the review (an unresolved one does not block
 * the import, spec §4.1); they are never fetched. Only then is the extension handed to
 * `ExtensionInstalls.ingest` (source `catalog`), the skill / template / icon files written to object
 * storage, a staging row written (24 hours) and `catalog.plugin_staged` audited.
 *
 * confirm: `reviewHash` must match the staging; in one transaction it deletes the staging row
 * (confirm works once), locks the extension name and recomputes its deployment state (installed /
 * upgraded / swapped after the review -> `plugin.review_stale`), writes the extension's permission
 * snapshot when it is installed by this import (or upgraded with `deployExtension`; source web, audit
 * `extension.permissions_approved` carrying the plugin), and creates the item or adds the version
 * (`manifest` = the normalized plugin.json, `extension_sha256`, the files under the staging prefix).
 * After the commit, with `deployExtension`, the plugin's own extension is installed on the
 * deployment and enabled (`ExtensionAdminOps.install` + `enable`; each replica reconciles, no
 * restart); a failure is returned, not thrown, and an upgrade that was not installed gets its old
 * snapshot back.
 *
 * Expired staging is cleaned by the maintenance job `app-staging-cleanup`
 * ({@link PluginImport.cleanupExpired}): it deletes the staging row and its object prefix; a stored
 * extension package stays in the content-addressed `extension_packages` (the same as importing the
 * same tgz again; without an install record referencing it it is never loaded).
 */

/** How long a staged import is kept. */
export const PLUGIN_STAGING_TTL_MS = 24 * 3600_000;
/** Staging rows cleaned per batch. */
const CLEANUP_BATCH = 100;

/** The deployment state of the plugin's extension and what confirming with `deployExtension` does. */
export type ExtensionReviewAction = "install" | "upgrade" | "keep";

/** The plugin's extension in a review. */
export interface PluginReviewExtension {
  name: string;
  version: string;
  /** sha256 of the plugin tgz (the package store key). */
  sha256: string;
  /**
   * install: not on the deployment; upgrade: installed from another package (another version), the
   * import's package replaces it when deployed; keep: this exact package is installed.
   */
  action: ExtensionReviewAction;
  /** Installed on the deployment (any version). */
  deployed: boolean;
  /** The installed version (null when not installed). */
  currentVersion: string | null;
  /** The installed package (null when not installed). */
  currentSha256: string | null;
  /** Permissions from the static manifest and migration SQL (no extension code runs). */
  permissions: PermissionGroup[];
  /** Permission keys added / removed against the current snapshot (all added without one). */
  added: string[];
  addedItems: PermissionItem[];
  removed: string[];
  /** Review warnings of the migration SQL (sensitive). */
  warnings: PackageWarning[];
  /** The extension's own review digest (as when its package is uploaded alone). */
  reviewHash: string;
  /** Sensitive permissions or migration warnings. */
  sensitive: boolean;
}

/** One connector template in a review. */
export interface PluginReviewTemplate {
  id: string;
  displayName: LocalizedName;
  description: string;
  plugin: string;
  connector: string;
  endpoint: Record<string, unknown>;
  auth: Record<string, unknown>;
  editableEndpoint: string[];
  /** The connector is loaded on this replica and the endpoint was checked against its schema. */
  endpointChecked: boolean;
}

/** The source of a staged import. */
export interface PluginImportSource {
  kind: "file" | "npm" | "marketplace";
  ref: string;
  integrity?: string;
  marketplaceId?: string;
}

/** The one review of a plugin (the enterprise admin sees every component before confirming). */
export interface PluginReview {
  name: string;
  version: string;
  packageName: string;
  publisher: string;
  description: string;
  displayName?: LocalizedName;
  license?: string;
  homepage?: string;
  extension?: PluginReviewExtension;
  skills: { name: string; description: string; body: string; path: string; files: number }[];
  connectorTemplates: PluginReviewTemplate[];
  /**
   * Each dependency with the highest imported catalog version satisfying its range (null when
   * nothing does yet: the import still completes, an org install is refused until it is imported).
   */
  dependencies: { name: string; range: string; resolved: string | null }[];
  source: PluginImportSource;
  /** The extension is sensitive. */
  sensitive: boolean;
  /** Digest of everything above that confirm depends on; sent back on confirm. */
  reviewHash: string;
}

/** The deploy result of the plugin's extension with `deployExtension`. */
export interface ExtensionDeployResult {
  name: string;
  action: "install" | "upgrade";
  version: string;
  /** The package to install (retry through the extension admin with it after a failure). */
  sha256: string;
  /** enabled: installed and enabled; failed: see code / message. */
  result: "enabled" | "failed";
  code?: string;
  message?: string;
  /** e.g. `snapshot_not_restored: …` when an upgrade failed and the snapshot had changed since. */
  note?: string;
}

/** The result of {@link PluginImport.confirm}. */
export interface PluginConfirmResult {
  item: CatalogItemView;
  /** null without `deployExtension` or when there is nothing to deploy (no extension, keep). */
  deploy: ExtensionDeployResult | null;
}

/** What prepare checks besides the package itself (npm and marketplace imports). */
export interface PluginPrepareExpect {
  /** The npm package that was requested (package.json `name` must equal it). */
  packageName?: string;
  /**
   * Marketplace import: the entry the package must match (`marketplace.package_mismatch`) and its
   * permission summary (`permissions`, compared with the package's keys: a warning only).
   */
  marketplace?: {
    name: string;
    version: string | null;
    packageName?: string;
    permissions?: string[];
  };
}

/** The snapshot overwritten at confirm (restored when deploying an upgrade fails). */
interface PreviousSnapshot {
  version: string;
  permissions: PermissionSet;
  approvedBy: string | null;
  approvedAt: Date;
  source: "auto" | "web" | "cli";
}

/** What prepare stages for confirm (`plugin_import_staging.manifest`). */
interface StagedPlugin {
  itemId: string;
  packageName: string;
  version: string;
  size: number;
  /** The normalized plugin.json (skills and connector templates listed). */
  manifest: PluginManifest;
  files: { path: string; size: number; sha256: string }[];
  /** A marketplace import's permission summary differs from the package (shown with the review). */
  permissionsMismatch?: PermissionsMismatch;
}

export interface PluginImportDeps {
  db: KernelDb;
  config: () => KernelConfig;
  storage: StorageService;
  installs: Pick<ExtensionInstalls, "ingest" | "fetchNpm">;
  ops: Pick<ExtensionAdminOps, "install" | "enable">;
  /** Reads a package from the package store (confirm recomputes the permission set). */
  blobs: { get(sha256: string): Promise<Uint8Array> };
  /** Builtin and config-declared extension names -> source. */
  declared: () => ReadonlyMap<string, ExtensionSource>;
  /** The connector `kind` provided by extension `plugin` loaded on this replica. */
  findConnector: (plugin: string, kind: string) => Connector | undefined;
  /** The version of an extension loaded on this replica (templates' `pluginVersion` is checked). */
  pluginVersion?: (plugin: string) => string | undefined;
  log: Pick<Logger, "info" | "warn" | "error">;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () =>
  new ApiError(
    "plugin.staging_not_found",
    "This plugin import was not found or has expired (staged imports are kept for 24 hours); prepare it again",
  );
const invalid = (problems: string[]) =>
  new ApiError(
    "catalog.invalid_manifest",
    `Invalid plugin package: ${problems[0] ?? "unknown problem"}`,
    problems.slice(0, 50),
  );
const mismatch = (what: string) =>
  new ApiError(
    "marketplace.package_mismatch",
    `The downloaded package does not match the marketplace entry: ${what}`,
  );

/**
 * The API error of a plugin package that cannot be read in a catalog path: the pre-0.1.0 format ->
 * `catalog.legacy_format`, anything else -> `catalog.invalid_manifest` (issues as details).
 */
export function catalogPackageError(e: PluginPackageError | ExtensionPackageError): ApiError {
  const legacy = e.code === "catalog.legacy_format" || e.code === "extension.legacy_format";
  if (legacy) return new ApiError("catalog.legacy_format", e.message, e.issues);
  return invalid(e.issues);
}

/** Runs a package read, mapping its errors with {@link catalogPackageError}. */
async function readingPackage<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof PluginPackageError || e instanceof ExtensionPackageError) {
      throw catalogPackageError(e);
    }
    throw e;
  }
}

const satisfies = (version: string, range: string) =>
  semver.satisfies(version, range, { includePrerelease: true });

const fileOf = (path: string, data: Uint8Array): SkillPackageFile => ({
  path,
  size: data.byteLength,
  sha256: createHash("sha256").update(data).digest("hex"),
  data,
});

type Trx = Transaction<KernelDatabase>;

/** The deployment state of the plugin's extension. */
type ExtensionState =
  | { kind: "installed"; version: string; sha256: string; packageName: string }
  | { kind: "absent" };

export class PluginImport {
  constructor(private readonly d: PluginImportDeps) {}

  /** Reads, checks and stages a plugin (see the file header). Returns the staging id and review. */
  async prepare(
    actor: string,
    bytes: Uint8Array,
    source: PluginImportSource,
    opts: ActorOpts & { expect?: PluginPrepareExpect } = {},
  ): Promise<{
    stagingId: string;
    review: PluginReview;
    permissionKeys: string[];
    permissionsMismatch: PermissionsMismatch;
  }> {
    const maxBytes = this.d.config().packages.maxBytes;

    // 1. Every check (nothing written)
    const pkg = await readingPackage(() =>
      readPluginPackage(bytes, { maxBytes, hostSdkVersion: SDK_VERSION }),
    );
    const m = pkg.manifest;
    const packageName = String(pkg.packageJson.name);
    const version = m.version;
    this.checkExpected(pkg, opts.expect);
    const ext = m.extension
      ? await readingPackage(() =>
          readExtensionPackage(bytes, { maxBytes, hostSdkVersion: SDK_VERSION }),
        )
      : undefined;
    const content = this.checkContent(pkg);
    const existing = await precheckCatalogImport(this.d.db, m.name, packageName, version);
    // The catalog name space is the extension name space: a declarative plugin cannot take a
    // builtin's / config-declared or another package's extension name either
    this.assertNotDeclared(m.name);
    await assertPluginNameOwner(this.d.db, m.name, packageName);
    let extension: PluginReviewExtension | undefined;
    if (ext) {
      extension = await this.reviewExtension(ext, await this.extensionState(m.name, packageName));
      await assertDowngradable(this.d.db, extension, ext.migrationSql);
    }
    if (content.files.length > 0) this.d.storage.assertAvailable();
    const src: PluginImportSource = {
      kind: source.kind,
      ref: source.ref,
      ...(source.integrity !== undefined && { integrity: source.integrity }),
      ...(source.marketplaceId !== undefined && { marketplaceId: source.marketplaceId }),
    };
    const review: PluginReview = {
      name: m.name,
      version,
      packageName,
      publisher: m.publisher,
      description: m.description,
      ...(m.displayName !== undefined && { displayName: m.displayName }),
      ...(m.license !== undefined && { license: m.license }),
      ...(m.homepage !== undefined && { homepage: m.homepage }),
      ...(extension && { extension }),
      skills: content.skills,
      connectorTemplates: content.templates,
      dependencies: await this.resolveDependencies(m),
      source: src,
      sensitive: extension?.sensitive === true,
      reviewHash: "",
    };
    review.reviewHash = pluginReviewHash(review, content.files);
    // Re-check under the lock that the actor is still an enterprise admin before writing
    await this.d.db.transaction().execute((trx) => lockEnterpriseAdminsAndAuthorize(trx, actor));

    // 2. Write: the extension into the package store, files into object storage, the staging row
    const stagingId = randomUUID();
    const itemId = existing?.id ?? randomUUID();
    if (ext) {
      await this.d.installs.ingest(
        actor,
        bytes,
        {
          source: "catalog",
          ref: src.kind === "marketplace" ? `catalog:${src.ref}` : `${itemId}@${version}`,
        },
        opts.actorTokenId !== undefined ? { actorTokenId: opts.actorTokenId } : {},
      );
    }
    let objectPrefix: string | null = null;
    if (content.files.length > 0) {
      objectPrefix = catalogObjectPrefix(itemId, version, stagingId);
      await putCatalogFiles(this.d.storage, objectPrefix, content.files);
    }
    const keys = ext
      ? permissionKeys(permissionSetOfPackage(ext))
          .filter((k) => !k.startsWith(WARNINGS_KEY_PREFIX))
          .sort()
      : [];
    const mismatch = permissionsMismatch(
      opts.expect?.marketplace?.permissions,
      ext ? keys : undefined,
    );
    const staged: StagedPlugin = {
      itemId,
      packageName,
      version,
      size: bytes.byteLength,
      manifest: normalizedManifest(pkg),
      files: content.files.map(({ path, size, sha256 }) => ({ path, size, sha256 })),
      ...(mismatch !== null && { permissionsMismatch: mismatch }),
    };
    await this.d.db.transaction().execute(async (trx) => {
      await lockEnterpriseAdminsAndAuthorize(trx, actor);
      await trx
        .insertInto("plugin_import_staging")
        .values({
          id: stagingId,
          review: JSON.stringify(review),
          manifest: JSON.stringify(staged),
          object_prefix: objectPrefix,
          source: JSON.stringify(src),
          created_by: actor,
          expires_at: new Date(Date.now() + PLUGIN_STAGING_TTL_MS),
        })
        .execute();
      await audit(trx, {
        actorAccountId: actor,
        ...(opts.actorTokenId !== undefined && { actorTokenId: opts.actorTokenId }),
        action: "catalog.plugin_staged",
        target: stagingId,
        detail: {
          stagingId,
          name: m.name,
          version,
          source: src.kind,
          sourceRef: src.ref,
          ...(src.integrity !== undefined && { integrity: src.integrity }),
          ...(src.marketplaceId !== undefined && { marketplaceId: src.marketplaceId }),
          reviewHash: review.reviewHash,
          ...(extension && {
            extension: { sha256: extension.sha256, action: extension.action },
          }),
        },
      });
    });
    return { stagingId, review, permissionKeys: keys, permissionsMismatch: mismatch };
  }

  /** Fetches a plugin from the configured npm registry (verified by `dist.integrity`), then prepares it. */
  async prepareNpm(
    actor: string,
    input: { package: string; version?: string },
    opts: ActorOpts = {},
  ): Promise<{ stagingId: string; review: PluginReview }> {
    const got = await this.d.installs.fetchNpm(input);
    const r = await this.prepare(
      actor,
      got.bytes,
      { kind: "npm", ref: `${input.package}@${got.version}`, integrity: got.integrity },
      { ...opts, expect: { packageName: input.package } },
    );
    return { stagingId: r.stagingId, review: r.review };
  }

  /**
   * A staged import's review, as prepare returned it, with a marketplace import's permission
   * mismatch when there is one (the import page loads `?staging=<id>` with it). Unknown, expired or
   * already confirmed -> 404 `plugin.staging_not_found`.
   */
  async staged(stagingId: string): Promise<{
    stagingId: string;
    review: PluginReview;
    permissionsMismatch?: PermissionsMismatch;
  }> {
    if (!UUID_RE.test(stagingId)) throw notFound();
    const row = await this.d.db
      .selectFrom("plugin_import_staging")
      .select(["id", "review", "manifest"])
      .where("id", "=", stagingId)
      .where("expires_at", ">", sql<Date>`now()`)
      .executeTakeFirst();
    if (!row) throw notFound();
    const mismatch = (row.manifest as StagedPlugin).permissionsMismatch;
    return {
      stagingId: row.id,
      review: row.review as PluginReview,
      ...(mismatch !== undefined && mismatch !== null && { permissionsMismatch: mismatch }),
    };
  }

  /**
   * Confirms a staged import (see the file header). Returns the committed catalog item and, with
   * `deployExtension`, the extension's deploy result (a failed deploy is returned, not thrown).
   */
  async confirm(
    actor: string,
    stagingId: string,
    input: { reviewHash: string; deployExtension: boolean },
    opts: ActorOpts = {},
  ): Promise<PluginConfirmResult> {
    if (!UUID_RE.test(stagingId)) throw notFound();
    const row = await this.d.db
      .selectFrom("plugin_import_staging")
      .selectAll()
      .where("id", "=", stagingId)
      .where("expires_at", ">", sql<Date>`now()`)
      .executeTakeFirst();
    if (!row) throw notFound();
    const review = row.review as PluginReview;
    const staged = row.manifest as StagedPlugin;
    const src = row.source as PluginImportSource;
    const stale = () =>
      new ApiError(
        "plugin.review_stale",
        `The review of plugin ${review.name} ${review.version} is out of date (it changed, or its extension on this deployment changed since it was prepared); review it again`,
      );
    if (input.reviewHash !== review.reviewHash) throw stale();
    const reviewed = review.extension;
    // Read the stored package outside the transaction (unless it was already installed as is)
    const stored =
      reviewed && reviewed.action !== "keep" ? await this.readStored(reviewed.sha256) : undefined;

    const committed = await this.d.db.transaction().execute(async (trx) => {
      await lockEnterpriseAdminsAndAuthorize(trx, actor);
      const used = await trx
        .deleteFrom("plugin_import_staging")
        .where("id", "=", stagingId)
        .where("expires_at", ">", sql<Date>`now()`)
        .returning("id")
        .executeTakeFirst();
      if (!used) throw notFound();
      let now: PluginReviewExtension | undefined;
      let previous: PreviousSnapshot | null | undefined;
      if (reviewed) {
        // The same per-name advisory lock as ExtensionAdminOps.install; under it the action is
        // recomputed from the current deployment state (installed / upgraded / swapped since the
        // review -> stale)
        await sql`SELECT pg_advisory_xact_lock(hashtext(${`capybara.plugin-install:${reviewed.name}`}))`.execute(
          trx,
        );
        now = {
          ...reviewed,
          ...actionOf(
            await this.extensionState(reviewed.name, staged.packageName, trx),
            reviewed.sha256,
          ),
        };
        if (pluginReviewHash({ ...review, extension: now }, staged.files) !== review.reviewHash) {
          throw stale();
        }
        // A foreseeable deploy failure (a downgrade to a version with unrun migrations) is refused
        // before anything is written
        if (input.deployExtension && now.action === "upgrade" && stored) {
          await assertDowngradable(trx, now, stored.migrationSql);
        }
        if (now.action === "install" || (now.action === "upgrade" && input.deployExtension)) {
          previous = await this.approve(
            trx,
            actor,
            review,
            staged,
            now,
            stored as ExtensionPackage,
            opts,
          );
        }
      }
      const m = staged.manifest;
      const itemId = await writeCatalogVersion(trx, {
        actor,
        ...(opts.actorTokenId !== undefined && { actorTokenId: opts.actorTokenId }),
        name: m.name,
        packageName: staged.packageName,
        version: staged.version,
        manifest: m,
        listing: {
          publisher: m.publisher,
          description: m.description,
          displayName: m.displayName ?? null,
        },
        newItemId: staged.itemId,
        source: {
          source: src.kind,
          ref: src.ref,
          ...(src.integrity !== undefined && { integrity: src.integrity }),
        },
        ...(src.marketplaceId !== undefined && { marketplaceId: src.marketplaceId }),
        objectPrefix: row.object_prefix,
        extensionSha256: reviewed?.sha256 ?? null,
        files: staged.files,
        size: staged.size,
        auditDetail: {
          stagingId,
          deployExtension: input.deployExtension,
          ...(now && { extension: { name: now.name, version: now.version, action: now.action } }),
        },
      });
      return { itemId, now, previous };
    });

    const { now } = committed;
    const deploy =
      input.deployExtension && now && now.action !== "keep"
        ? await this.deploy(actor, review, committed.itemId, now, committed.previous, opts)
        : null;
    return { item: await this.itemView(committed.itemId), deploy };
  }

  /**
   * Writes the extension's permission snapshot for the version being imported (source web), after
   * registering the name owner like ExtensionAdminOps.install (Ruling P3). Returns the snapshot it
   * overwrote (null when there was none).
   */
  private async approve(
    trx: Trx,
    actor: string,
    review: PluginReview,
    staged: StagedPlugin,
    p: PluginReviewExtension,
    pkg: ExtensionPackage,
    opts: ActorOpts,
  ): Promise<PreviousSnapshot | null> {
    const set = permissionSetOfPackage(pkg);
    await sql`SELECT pg_advisory_xact_lock(hashtext(${`capybara.plugin-approve:${p.name}`}))`.execute(
      trx,
    );
    const snapRow = await trx
      .selectFrom("extension_permission_snapshots")
      .selectAll()
      .where("plugin", "=", p.name)
      .forUpdate()
      .executeTakeFirst();
    await trx
      .insertInto("extension_name_owners")
      .values({ name: p.name, package_name: staged.packageName })
      .onConflict((oc) => oc.column("name").doNothing())
      .execute();
    await assertPluginNameOwner(trx, p.name, staged.packageName);
    const { added, removed } = diffPermissions(
      snapRow?.permissions as PermissionSet | undefined,
      set,
    );
    await writeSnapshot(trx, p.name, p.version, set, {
      source: "web",
      approvedBy: actor,
      ...(opts.actorTokenId !== undefined && { actorTokenId: opts.actorTokenId }),
      audit: {
        added,
        removed,
        sha256: p.sha256,
        app: { name: review.name, version: review.version },
      },
    });
    return snapRow
      ? {
          version: snapRow.version,
          permissions: snapRow.permissions as PermissionSet,
          approvedBy: snapRow.approved_by,
          approvedAt: snapRow.approved_at,
          source: snapRow.source,
        }
      : null;
  }

  /**
   * Deploys the plugin's extension after the commit: `install` (a new install is disabled, a version
   * change keeps the desired state) then `enable`. Nothing is thrown; the result says what happened.
   * When an upgrade was not installed, the snapshot overwritten at confirm is restored (the old
   * version keeps running, F-O; audit `extension.permissions_restored`). Retry through the extension
   * admin (the package is already in the package store) with the sha256 from the result.
   */
  private async deploy(
    actor: string,
    review: PluginReview,
    itemId: string,
    p: PluginReviewExtension,
    previous: PreviousSnapshot | null | undefined,
    opts: ActorOpts,
  ): Promise<ExtensionDeployResult> {
    const base = {
      name: p.name,
      action: p.action as "install" | "upgrade",
      version: p.version,
      sha256: p.sha256,
    };
    const failure = (e: unknown) =>
      e instanceof ApiError
        ? { code: e.code as string, message: e.message }
        : { code: "internal", message: "Internal error" };
    try {
      await this.d.ops.install(p.name, p.sha256, actor, opts.actorTokenId, {
        catalogItemId: itemId,
      });
    } catch (e) {
      this.d.log.warn("installing a plugin's extension on the deployment failed", {
        plugin: review.name,
        err: e,
      });
      const result: ExtensionDeployResult = { ...base, result: "failed", ...failure(e) };
      if (p.action === "upgrade" && previous !== undefined) {
        try {
          if (!(await this.restoreSnapshot(actor, review, p, previous, opts))) {
            result.note =
              "snapshot_not_restored: the permission approval changed after the import was confirmed, so it was left as it is";
          }
        } catch (err) {
          this.d.log.error("cannot restore the permission snapshot of a plugin's extension", {
            plugin: p.name,
            err,
          });
        }
      }
      return result;
    }
    try {
      await this.d.ops.enable(p.name, actor, opts.actorTokenId);
      return { ...base, result: "enabled" };
    } catch (e) {
      this.d.log.warn("enabling a plugin's extension failed", { plugin: p.name, err: e });
      return { ...base, result: "failed", ...failure(e) };
    }
  }

  /**
   * Restores the snapshot overwritten at confirm (deletes it when there was none before), audits
   * `extension.permissions_restored`. Compare-and-write (row locked): restores only while the
   * snapshot is still the one written at confirm (this version, approved by this actor); if someone
   * approved or changed it meanwhile it is left alone and false is returned.
   */
  private async restoreSnapshot(
    actor: string,
    review: PluginReview,
    p: PluginReviewExtension,
    prev: PreviousSnapshot | null,
    opts: ActorOpts,
  ): Promise<boolean> {
    return this.d.db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`capybara.plugin-approve:${p.name}`}))`.execute(
        trx,
      );
      const current = await trx
        .selectFrom("extension_permission_snapshots")
        .select(["version", "approved_by"])
        .where("plugin", "=", p.name)
        .forUpdate()
        .executeTakeFirst();
      if (current?.version !== p.version || current.approved_by !== actor) return false;
      if (prev) {
        await trx
          .updateTable("extension_permission_snapshots")
          .set({
            version: prev.version,
            permissions: JSON.stringify(prev.permissions),
            approved_by: prev.approvedBy,
            approved_at: prev.approvedAt,
            source: prev.source,
          })
          .where("plugin", "=", p.name)
          .execute();
      } else {
        await trx
          .deleteFrom("extension_permission_snapshots")
          .where("plugin", "=", p.name)
          .execute();
      }
      await audit(trx, {
        actorAccountId: actor,
        ...(opts.actorTokenId !== undefined && { actorTokenId: opts.actorTokenId }),
        action: "extension.permissions_restored",
        target: p.name,
        detail: {
          plugin: p.name,
          restoredVersion: prev?.version ?? null,
          reason: "plugin_deploy_failed",
          app: { name: review.name, version: review.version },
        },
      });
      return true;
    });
  }

  /**
   * Deletes expired staging rows and their object prefixes (maintenance job `app-staging-cleanup`).
   * Row by row: objects first, then the row (a failed object delete keeps the row for the next
   * round); concurrent replicas skip each other's rows (`SKIP LOCKED`). Returns the rows deleted.
   */
  async cleanupExpired(): Promise<number> {
    let total = 0;
    for (;;) {
      const batch = await this.d.db
        .selectFrom("plugin_import_staging")
        .select(["id", "object_prefix"])
        .where("expires_at", "<=", sql<Date>`now()`)
        .orderBy("expires_at")
        .limit(CLEANUP_BATCH)
        .execute();
      if (batch.length === 0) return total;
      let progressed = 0;
      for (const r of batch) {
        try {
          const done = await this.d.db.transaction().execute(async (trx) => {
            const locked = await trx
              .selectFrom("plugin_import_staging")
              .select("id")
              .where("id", "=", r.id)
              .where("expires_at", "<=", sql<Date>`now()`)
              .forUpdate()
              .skipLocked()
              .executeTakeFirst();
            if (!locked) return false;
            if (r.object_prefix) await this.d.storage.deployment().deletePrefix(r.object_prefix);
            await trx.deleteFrom("plugin_import_staging").where("id", "=", r.id).execute();
            return true;
          });
          if (done) {
            total++;
            progressed++;
          }
        } catch (err) {
          this.d.log.warn("cannot clean up an expired plugin import", { stagingId: r.id, err });
        }
      }
      if (progressed === 0 || batch.length < CLEANUP_BATCH) return total;
    }
  }

  // ---------------------------------------------------------------------------------------------

  /** npm / marketplace imports: the package must be the one that was asked for. */
  private checkExpected(pkg: PluginPackage, expect: PluginPrepareExpect | undefined): void {
    const packageName = String(pkg.packageJson.name);
    if (expect?.packageName !== undefined && packageName !== expect.packageName) {
      throw invalid([
        `package.json name "${packageName}" does not match the requested npm package ${expect.packageName}`,
      ]);
    }
    const e = expect?.marketplace;
    if (!e) return;
    if (e.packageName !== undefined && packageName !== e.packageName) {
      throw mismatch(`package.json name is "${packageName}", the entry says ${e.packageName}`);
    }
    if (pkg.manifest.name !== e.name) {
      throw mismatch(`the plugin is named "${pkg.manifest.name}", the entry says ${e.name}`);
    }
    if (e.version !== null && pkg.manifest.version !== e.version) {
      throw mismatch(
        `the plugin's version is ${pkg.manifest.version}, the entry says ${e.version}`,
      );
    }
  }

  /** A builtin / config-declared extension's name cannot be taken by an imported plugin. */
  private assertNotDeclared(name: string): void {
    const declared = this.d.declared().get(name);
    if (declared === "builtin") {
      throw new ApiError(
        "extension.builtin",
        `Extension ${name} is built into this deployment; a plugin with this name cannot be imported`,
      );
    }
    if (declared === "config") {
      throw new ApiError(
        "extension.config_declared",
        `Extension ${name} is declared in the startup config (extensions); remove it there before importing a plugin with this name`,
      );
    }
  }

  /**
   * Skills (by the skill package rules), connector templates (against the loaded connector) and
   * icons; returns the files to store and the review's skills and templates.
   */
  private checkContent(pkg: PluginPackage): {
    files: SkillPackageFile[];
    templates: PluginReviewTemplate[];
    skills: PluginReview["skills"];
  } {
    const m = pkg.manifest;
    const problems: string[] = [];
    const stored = new Map<string, SkillPackageFile>();
    const keep = (path: string) => {
      const data = pkg.files.get(path);
      if (data !== undefined && !stored.has(path)) stored.set(path, fileOf(path, data));
    };
    if (m.icon !== undefined) keep(packagePath(m.icon));

    const skills: PluginReview["skills"] = [];
    for (const s of pkg.skills) {
      const files = s.files.map((f) => fileOf(f, pkg.files.get(`${s.dir}/${f}`) as Uint8Array));
      try {
        const r = checkSkillFiles(files);
        const md = parseSkillMd(
          new TextDecoder().decode(pkg.files.get(`${s.dir}/${SKILL_ENTRY_FILE}`)),
        );
        skills.push({
          name: r.name,
          description: r.description,
          body: "errors" in md ? "" : md.body,
          path: `./${s.dir}`,
          files: files.length,
        });
        for (const f of s.files) keep(`${s.dir}/${f}`);
      } catch (e) {
        if (!(e instanceof SkillArchiveError)) throw e;
        for (const p of e.problems) problems.push(`${s.dir}: ${p}`);
      }
    }

    const local = new Set([
      ...(m.extension ? [m.name] : []),
      ...(m.dependencies ?? []).map((d) => d.name),
    ]);
    const templates: PluginReviewTemplate[] = pkg.connectorTemplates.map((c) => {
      const t: ConnectorTemplateSpec = c.file.template;
      const at = `${c.path}: template`;
      // The result depends on which connectors the replica serving this request has loaded right
      // now: it is the import-time gate, not the last word (an org install checks again against the
      // connector of the moment)
      const loaded = this.d.findConnector(t.plugin, t.connector);
      if (loaded) {
        problems.push(...templateProblems(loaded, t, at));
        const v = this.d.pluginVersion?.(t.plugin);
        if (t.pluginVersion !== undefined && v !== undefined && !satisfies(v, t.pluginVersion)) {
          problems.push(
            `${at}.pluginVersion: extension ${t.plugin} is loaded at version ${v}, which does not satisfy ${t.pluginVersion}`,
          );
        }
      } else if (local.has(t.plugin)) {
        // The connector comes with this plugin or a dependency: static checks only now
        for (const leak of endpointCredentialIssues(t.endpoint)) {
          problems.push(`${at}.${leak.path}: ${leak.message}`);
        }
      } else {
        problems.push(
          `${at}.connector: extension ${t.plugin} providing connector "${t.connector}" is not loaded in this deployment and is neither this plugin's extension nor a dependency`,
        );
      }
      keep(c.path);
      if (c.file.icon !== undefined) keep(packagePath(c.file.icon));
      return {
        id: c.id,
        displayName: c.file.displayName,
        description: c.file.description ?? "",
        plugin: t.plugin,
        connector: t.connector,
        endpoint: t.endpoint,
        auth: t.auth as unknown as Record<string, unknown>,
        editableEndpoint: t.editableEndpoint ?? [],
        endpointChecked: loaded !== undefined,
      };
    });
    if (problems.length > 0) throw invalid(problems);
    return { files: [...stored.values()], templates, skills };
  }

  /**
   * The highest imported, non-deleted catalog version satisfying each dependency's range (null when
   * none does).
   */
  private async resolveDependencies(m: PluginManifest): Promise<PluginReview["dependencies"]> {
    const deps = m.dependencies ?? [];
    if (deps.length === 0) return [];
    const rows = await this.d.db
      .selectFrom("catalog_items as i")
      .innerJoin("catalog_item_versions as v", "v.item_id", "i.id")
      .select(["i.name", "v.version"])
      .where("i.deleted_at", "is", null)
      .where(
        "i.name",
        "in",
        deps.map((d) => d.name),
      )
      .execute();
    return deps.map((d) => ({
      name: d.name,
      range: d.version,
      resolved:
        semver.maxSatisfying(
          rows.filter((r) => r.name === d.name).map((r) => r.version),
          d.version,
          { includePrerelease: true },
        ) ?? null,
    }));
  }

  /**
   * The extension's state on the deployment; installed from another npm package ->
   * `extension.name_conflict`.
   */
  private async extensionState(
    name: string,
    packageName: string,
    db: KernelDb | Trx = this.d.db,
  ): Promise<ExtensionState> {
    const r = await db
      .selectFrom("extension_installs")
      .innerJoin("extension_packages", "extension_packages.sha256", "extension_installs.sha256")
      .select([
        "extension_installs.version",
        "extension_installs.sha256",
        "extension_packages.package_name",
      ])
      .where("extension_installs.name", "=", name)
      .executeTakeFirst();
    if (r && r.package_name !== packageName) {
      throw new ApiError(
        "extension.name_conflict",
        `Extension ${name} is already installed from package ${r.package_name}; package ${packageName} cannot use it`,
      );
    }
    return r
      ? { kind: "installed", version: r.version, sha256: r.sha256, packageName: r.package_name }
      : { kind: "absent" };
  }

  /** The review of the extension: permissions, the change against the snapshot, warnings, action. */
  private async reviewExtension(
    pkg: ExtensionPackage,
    state: ExtensionState,
  ): Promise<PluginReviewExtension> {
    const name = pkg.section.name;
    const snap = await this.d.db
      .selectFrom("extension_permission_snapshots")
      .select("permissions")
      .where("plugin", "=", name)
      .executeTakeFirst();
    const set = permissionSetOfPackage(pkg);
    const warnings = migrationWarnings(pkg.migrationSql, name);
    const { added, removed } = diffPermissions(snap?.permissions as PermissionSet | undefined, set);
    const permissions = permissionGroups(set);
    return {
      name,
      version: pkg.section.version,
      sha256: pkg.sha256,
      ...actionOf(state, pkg.sha256),
      permissions,
      added,
      addedItems: permissionKeyItems(added),
      removed,
      warnings,
      reviewHash: extensionReviewHash(set, warnings),
      sensitive: permissions.some((g) => g.sensitive) || warnings.length > 0,
    };
  }

  private async readStored(sha256: string): Promise<ExtensionPackage> {
    const bytes = await this.d.blobs.get(sha256);
    return readingPackage(() =>
      readExtensionPackage(bytes, {
        maxBytes: this.d.config().packages.maxBytes,
        hostSdkVersion: SDK_VERSION,
      }),
    );
  }

  private async itemView(itemId: string): Promise<CatalogItemView> {
    const item = await this.d.db
      .selectFrom("catalog_items")
      .selectAll()
      .where("id", "=", itemId)
      .executeTakeFirstOrThrow();
    const versions = await this.d.db
      .selectFrom("catalog_item_versions")
      .select(["version", "source"])
      .where("item_id", "=", itemId)
      .execute();
    return itemView(item, versions);
  }
}

/**
 * plugin.json as stored on the version: skills and connector templates listed explicitly (what was
 * scanned when the manifest omitted them), `pinned` kept from the listing.
 */
function normalizedManifest(pkg: PluginPackage): PluginManifest {
  const pinned = new Map(
    (pkg.manifest.skills ?? []).map((s) => [packagePath(s.path), s.pinned] as const),
  );
  return {
    ...pkg.manifest,
    skills: pkg.skills.map((s) => {
      const p = pinned.get(s.dir);
      return { path: `./${s.dir}`, ...(p !== undefined && { pinned: p }) };
    }),
    connectorTemplates: pkg.connectorTemplates.map((t) => ({ path: `./${t.path}` })),
  };
}

/** The extension's deployment state -> action and current version. */
function actionOf(
  s: ExtensionState,
  sha256: string,
): Pick<PluginReviewExtension, "action" | "deployed" | "currentVersion" | "currentSha256"> {
  if (s.kind === "installed") {
    return {
      action: s.sha256 === sha256 ? "keep" : "upgrade",
      deployed: true,
      currentVersion: s.version,
      currentSha256: s.sha256,
    };
  }
  return { action: "install", deployed: false, currentVersion: null, currentSha256: null };
}

/**
 * The review digest (first 32 hex of a sha256): name and version, the extension (sha256, action,
 * current version / package, its own review digest), every template field, each skill's name / path
 * / file count, the dependency resolution, and the sha256 of every stored file.
 */
function pluginReviewHash(
  r: Pick<
    PluginReview,
    "name" | "version" | "extension" | "connectorTemplates" | "skills" | "dependencies"
  >,
  files: { path: string; sha256: string }[],
): string {
  const e = r.extension;
  const canonical = JSON.stringify([
    r.name,
    r.version,
    e ? [e.name, e.sha256, e.action, e.currentVersion, e.currentSha256, e.reviewHash] : null,
    r.connectorTemplates.map((t) => [
      t.id,
      t.plugin,
      t.connector,
      t.endpoint,
      t.auth,
      t.editableEndpoint,
    ]),
    r.skills.map((s) => [s.name, s.path, s.files]),
    r.dependencies.map((d) => [d.name, d.range, d.resolved]),
    [...files].sort((a, b) => a.path.localeCompare(b.path)).map((f) => [f.path, f.sha256]),
  ]);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

/**
 * A version change that is a downgrade (the imported version below the installed one) whose
 * version has migrations not run on this deployment -> `extension.downgrade_unsupported` (the same
 * rule as `ExtensionAdminOps.install`: extension migrations are expand-only, a downgrade can only go
 * back to a version whose migrations have all run).
 */
async function assertDowngradable(
  db: KernelDb | Trx,
  p: Pick<PluginReviewExtension, "name" | "action" | "version" | "currentVersion">,
  migrationSql: { file: string; sql: string }[],
): Promise<void> {
  if (p.action !== "upgrade" || p.currentVersion === null) return;
  if (!semver.valid(p.currentVersion) || !semver.lt(p.version, p.currentVersion)) return;
  const unrun = await unrunMigrations(db, p.name, migrationSql);
  if (unrun.length > 0) {
    throw new ApiError(
      "extension.downgrade_unsupported",
      `The plugin's extension ${p.name} ${p.version} is older than the installed ${p.currentVersion}, and that version has migrations that were never run here (${unrun.join(", ")}); extension migrations only expand, so this downgrade is not possible`,
      unrun.map((file) => ({ file })),
    );
  }
}
