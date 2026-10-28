import { createHash, randomUUID } from "node:crypto";
import {
  type AgentTemplate,
  type AgentTemplateTier,
  type Connector,
  type ConnectorTemplateSpec,
  type LocalizedName,
  type Logger,
  PLUGIN_MANIFEST_FILE,
  type PluginManifest,
  parseSkillMd,
  SDK_VERSION,
  SKILL_ENTRY_FILE,
} from "@capybara-hq/plugin-sdk";
import { sql, type Transaction } from "kysely";
import semver from "semver";
import type { KernelConfig } from "../config/schema.js";
import type { KernelDatabase, KernelSchemaDb } from "../db/kernel-schema.js";
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
import type { EnterpriseAdminLock } from "../identity/enterprise-admin.js";
import type { ProvenanceResult } from "../packages/provenance.js";
import { packPackageTgz } from "../packages/tgz.js";
import { checkSkillFiles, SkillArchiveError, type SkillPackageFile } from "../skills/package.js";
import type { StorageService } from "../storage/storage.service.js";
import { endpointCredentialIssues } from "../tools/endpoint.js";
import { canonicalJson } from "../tools/registry.js";
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
  type SourceDetail,
  templateProblems,
  writeCatalogVersion,
} from "./catalog.service.js";
import {
  CLAUDE_PLUGIN_FILE,
  type ClaudeEntryOverlay,
  claudeContentDigest,
} from "./claude/manifest.js";
import { CLAUDE_MCP_CONNECTOR } from "./claude/mcp.js";
import {
  item as reportItem,
  sortItems,
  type TranslationItem,
  type TranslationReport,
} from "./claude/report.js";
import { isClaudePluginTree, translateClaudePlugin } from "./claude/translate.js";
import {
  type PluginContents,
  PluginPackageError,
  packagePath,
  readPluginFiles,
  readPluginPackage,
} from "./plugin-package.js";
import { maxSatisfying, satisfiesRange } from "./versions.js";

/**
 * Enterprise import of a plugin (package ecosystem spec §4.3): one review for every plugin, whatever
 * it contains (an extension, skills, connector templates, dependencies), confirmed once.
 *
 * prepare: the tgz is always hostile input, and **nothing is written until every check passes**
 * (F-AD): `readPluginPackage` (plugin.json, package.json, listed / scanned skills and templates,
 * icons; a pre-0.1.0 tgz is `catalog.legacy_format`), the extension's module graph and migrations
 * (`readExtensionPackage`), the extension's deployment state (config-declared names are
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

/** One agent template in a review (sub-agents spec §16.2: its tool narrowing and model tier). */
export interface PluginReviewAgentTemplate {
  name: string;
  /** Relative to the plugin root. */
  path: string;
  description: string;
  /** The instructions (the body). */
  instructions: string;
  /** Default `inherit`. */
  model: AgentTemplateTier;
  tools?: string[];
  disallowedTools?: string[];
  toolPolicies?: Record<string, "ask" | "deny">;
  effort?: AgentTemplate["effort"];
  maxSteps?: number;
  skills?: string[];
}

/** The source of a staged import. */
export interface PluginImportSource {
  /**
   * `git`: read from a git commit (a git marketplace's entry, or a direct git import);
   * `bootstrap`: a package baked into the image, imported by the bootstrap step (its extension
   * package is kept in PG, since the object store may be one of the bootstrap plugins; the
   * permission snapshot is written with source `bootstrap`).
   */
  kind: "file" | "npm" | "marketplace" | "git" | "bootstrap";
  ref: string;
  integrity?: string;
  marketplaceId?: string;
  /** Where it came from (stored on the catalog version as `source_detail`). */
  detail?: SourceDetail;
}

/** The format a plugin was read from: a Capybara plugin, or a translated Claude Code plugin. */
export type PluginSourceFormat = "capybara" | "claude-code";

/** Root license files, in the order they are looked for. */
const LICENSE_FILES = ["LICENSE", "LICENSE.md", "LICENSE.txt", "LICENCE"] as const;
/** The largest license text stored (bytes); a longer one is omitted (`licenseTruncated`). */
export const LICENSE_TEXT_MAX_BYTES = 65536;

/** The one review of a plugin (the enterprise admin sees every component before confirming). */
export interface PluginReview {
  name: string;
  /** `claude-code`: translated from a Claude Code plugin (no extension; see `translation`). */
  format: PluginSourceFormat;
  /** The translation report of a Claude Code plugin (spec §8.4). */
  translation?: TranslationReport;
  /** The tree has both manifests: `.capybara-plugin/plugin.json` was read, the Claude one ignored. */
  claudeManifestIgnored?: true;
  /**
   * `repository` of a Claude Code plugin's manifest (spec §8.2): display only, never checked or
   * fetched, not stored with the version.
   */
  repository?: string;
  /** The root LICENSE text (UTF-8, at most {@link LICENSE_TEXT_MAX_BYTES} bytes). */
  licenseText?: string;
  /** The root LICENSE is longer than {@link LICENSE_TEXT_MAX_BYTES} bytes (or not UTF-8) and is not stored. */
  licenseTruncated?: true;
  /**
   * The version recorded: the plugin's own (plugin.json, else the entry's, else the fallback of
   * spec §5.3), with `+git.<sha12>` / `+sha256.<12>` appended when that release is already imported
   * with other content (Decision 6).
   */
  version: string;
  /** The plugin's own version when `version` got build metadata appended. */
  pluginVersion?: string;
  /** The content digest of the plugin's files (Decision 5). */
  contentDigest: string;
  /** package.json `name`; null for a git plugin without package.json. */
  packageName: string | null;
  publisher: string;
  description: string;
  displayName?: LocalizedName;
  license?: string;
  homepage?: string;
  extension?: PluginReviewExtension;
  skills: {
    name: string;
    description: string;
    body: string;
    path: string;
    files: number;
    /** The plugin suggests pinning the skill (plugin.json `pinned`; changed at confirm). */
    suggestPinned: boolean;
  }[];
  connectorTemplates: PluginReviewTemplate[];
  /**
   * Agent templates (phase C). Absent in reviews staged before phase C (read as none); left out of
   * {@link pluginReviewHash} when empty, so their digests are unchanged.
   */
  agentTemplates?: PluginReviewAgentTemplate[];
  /**
   * Each dependency with the highest imported catalog version satisfying its range (null when
   * nothing does yet: the import still completes, an org install is refused until it is imported).
   */
  dependencies: { name: string; range: string; resolved: string | null }[];
  source: PluginImportSource;
  /**
   * npm provenance (spec §5.5, display only): "built from `repository`@`commit` by `workflow`" for
   * npm and npm-backed marketplace imports when the registry has it; otherwise not checked, with
   * the reason ("not an npm package" for every other source).
   */
  provenance: ProvenanceResult;
  /** A git marketplace's repository differs from the attested one (a warning, never a refusal). */
  provenanceWarning?: "repository_mismatch";
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
  /**
   * enabled: installed and enabled; installed: installed, desired state left as it was (confirm
   * with `enable: false`, the bootstrap step's upgrades); failed: see code / message.
   */
  result: "enabled" | "installed" | "failed";
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

/** The provenance shown with a review (fetched by the npm paths before prepare). */
export interface ReviewProvenance {
  provenance: ProvenanceResult;
  warning?: "repository_mismatch";
}

/** The provenance of every import that is not from npm. */
const NOT_NPM: ReviewProvenance = { provenance: { checked: false, reason: "not an npm package" } };

/** The snapshot overwritten at confirm (restored when deploying an upgrade fails). */
interface PreviousSnapshot {
  version: string;
  permissions: PermissionSet;
  approvedBy: string | null;
  approvedAt: Date;
  source: "auto" | "web" | "cli" | "bootstrap";
}

/** What prepare stages for confirm (`plugin_import_staging.manifest`). */
interface StagedPlugin {
  itemId: string;
  packageName: string | null;
  version: string;
  contentDigest: string;
  size: number;
  /** The normalized plugin.json (skills and connector templates listed). */
  manifest: PluginManifest;
  files: { path: string; size: number; sha256: string }[];
  /** A marketplace import's permission summary differs from the package (shown with the review). */
  permissionsMismatch?: PermissionsMismatch;
  /** Written to the version at confirm (absent in rows staged before phase B: `capybara`). */
  sourceFormat?: PluginSourceFormat;
  translation?: TranslationReport;
  licenseText?: string;
  licenseTruncated?: true;
}

export interface PluginImportDeps {
  /** The enterprise admin lock (identity/enterprise-admin.ts; R12): joins the caller's transaction. */
  adminLock: Pick<EnterpriseAdminLock, "lock" | "lockAndAuthorize">;
  db: KernelSchemaDb;
  config: () => KernelConfig;
  storage: StorageService;
  installs: Pick<ExtensionInstalls, "ingest" | "fetchNpm" | "fetchProvenance">;
  ops: Pick<ExtensionAdminOps, "install" | "enable">;
  /** Reads a package from the package store (confirm recomputes the permission set). */
  blobs: { get(sha256: string): Promise<Uint8Array> };
  /** Config-declared extension names -> source. */
  declared: () => ReadonlyMap<string, ExtensionSource>;
  /** The connector `kind` provided by extension `plugin` loaded on this replica. */
  findConnector: (plugin: string, kind: string) => Connector | undefined;
  /** The version of an extension loaded on this replica (templates' `pluginVersion` is checked). */
  pluginVersion?: (plugin: string) => string | undefined;
  /**
   * false: this process loads no connectors (the CLI), so a template of an unknown connector gets
   * only the static endpoint checks and `endpointChecked: false`; the org install re-checks it
   * against the loaded connector. Default true (the HTTP path).
   */
  connectorsLoaded?: boolean;
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

const fileOf = (path: string, data: Uint8Array): SkillPackageFile => ({
  path,
  size: data.byteLength,
  sha256: createHash("sha256").update(data).digest("hex"),
  data,
});

type Trx = Transaction<KernelDatabase>;

/**
 * The enterprise-admin re-check under the lock, in the caller's (legacy, R8) transaction. `actor`
 * null is the CLI (the operator of the deployment: no account to re-check, audits carry no actor),
 * like `ExtensionInstalls.ingest`.
 */
const authorizeActor = (
  adminLock: Pick<EnterpriseAdminLock, "lock" | "lockAndAuthorize">,
  actor: string | null,
): Promise<void> => (actor === null ? adminLock.lock() : adminLock.lockAndAuthorize(actor));

/** The deployment state of the plugin's extension. */
type ExtensionState =
  | { kind: "installed"; version: string; sha256: string; packageName: string }
  | { kind: "absent" };

export class PluginImport {
  constructor(private readonly d: PluginImportDeps) {}

  /**
   * Reads, checks and stages a plugin (see the file header). Returns the staging id and review.
   * `fallback` (a marketplace archive): a tgz without plugin.json may be skills only, named,
   * versioned and published by it (the version defaulting to `0.0.0-sha256.h<12>`, spec §5.3).
   */
  async prepare(
    actor: string | null,
    bytes: Uint8Array,
    source: PluginImportSource,
    opts: ActorOpts & {
      expect?: PluginPrepareExpect;
      fallback?: { name: string; version?: string; publisher: string };
      provenance?: ReviewProvenance;
      claudeManifestIgnored?: true;
    } = {},
  ): Promise<{
    stagingId: string;
    review: PluginReview;
    permissionKeys: string[];
    permissionsMismatch: PermissionsMismatch;
  }> {
    const maxBytes = this.d.config().packages.maxBytes;
    const pkg = await readingPackage(() =>
      readPluginPackage(bytes, {
        maxBytes,
        hostSdkVersion: SDK_VERSION,
        ...(opts.fallback !== undefined && { fallback: opts.fallback }),
      }),
    );
    const { fallback: _, ...rest } = opts;
    return this.prepareContents(actor, pkg, { bytes, size: bytes.byteLength }, source, rest);
  }

  /**
   * Checks and stages a plugin read from a git commit (`files` relative to the plugin root; see
   * `git-source.ts`): the same checks as a tgz ({@link readPluginFiles}), with package.json
   * optional (spec §4.1) and a skills-only tree without plugin.json named by `fallback` (Decision
   * 3). A plugin with an extension needs package.json (its peerDependencies ranges are checked as
   * for a tgz) and its build output; its files are packed into a deterministic tgz, which is what
   * the package store keeps and the deployment installs. Returns what {@link prepare} returns.
   */
  async prepareGit(
    actor: string | null,
    files: Map<string, Uint8Array>,
    source: PluginImportSource,
    opts: ActorOpts & {
      expect?: PluginPrepareExpect;
      /**
       * `version` is the entry's version, else derived from the commit (spec §5.3); `entryVersion`
       * is the entry's own (a Claude Code plugin reports where its version came from).
       */
      fallback: { name: string; version: string; publisher: string; entryVersion?: string };
      provenance?: ReviewProvenance;
      /** The Claude Code marketplace entry's overlay (the entry's components and `strict`). */
      claude?: ClaudeEntryOverlay;
    },
  ): Promise<{
    stagingId: string;
    review: PluginReview;
    permissionKeys: string[];
    permissionsMismatch: PermissionsMismatch;
  }> {
    const { fallback: _, claude, ...rest } = opts;
    if (!files.has(PLUGIN_MANIFEST_FILE) && isClaudePluginTree(files, claude)) {
      // A Claude Code plugin (spec §8): translated, then read like any git plugin; the content
      // digest is over the files as read and the entry's components, never the generated tree
      // (Review Focus 5, claudeContentDigest)
      const t = await readingPackage(async () =>
        translateClaudePlugin(files, {
          fallbackName: opts.fallback.name,
          fallbackVersion: opts.fallback.version,
          fallbackPublisher: opts.fallback.publisher,
          ...(opts.fallback.entryVersion !== undefined && {
            entryVersion: opts.fallback.entryVersion,
          }),
          ...(claude !== undefined && { overlay: claude }),
          allowInsecureLoopback: this.d.config().marketplaces.allowInsecureLoopback,
        }),
      );
      const translated = await readingPackage(async () =>
        readPluginFiles(t.tree, {
          hostSdkVersion: SDK_VERSION,
          requirePackageJson: false,
          invocationKeys: false,
        }),
      );
      const contents: PluginContents = {
        ...translated,
        contentDigest: claudeContentDigest(files, claude, t.translatorRevision),
      };
      let size = 0;
      for (const data of files.values()) size += data.byteLength;
      return this.prepareContents(actor, contents, { size }, source, {
        ...rest,
        claude: t.report,
        ...(t.repository !== undefined && { repository: t.repository }),
      });
    }
    const contents = await readingPackage(async () =>
      readPluginFiles(files, {
        hostSdkVersion: SDK_VERSION,
        requirePackageJson: false,
        fallbackName: opts.fallback.name,
        fallbackVersion: opts.fallback.version,
        fallbackPublisher: opts.fallback.publisher,
      }),
    );
    const next = {
      ...rest,
      // both manifests: the native one is read (spec §4.1) and the review says so
      ...(files.has(PLUGIN_MANIFEST_FILE) &&
        files.has(CLAUDE_PLUGIN_FILE) && { claudeManifestIgnored: true as const }),
    };
    if (contents.manifest.extension !== undefined) {
      if (!files.has("package.json")) {
        throw invalid([
          "package.json not found: a plugin with an extension needs package.json with peerDependencies (@capybara-hq/plugin-sdk, zod), which are checked against this host",
        ]);
      }
      return this.prepare(actor, await packPackageTgz(files), source, next);
    }
    let size = 0;
    for (const data of files.values()) size += data.byteLength;
    return this.prepareContents(actor, contents, { size }, source, next);
  }

  /**
   * The checks and writes of prepare after the package was read. `tgz.bytes` is the package tgz
   * (required with an extension: it is stored in the package store); `size` is recorded.
   */
  private async prepareContents(
    actor: string | null,
    pkg: PluginContents,
    tgz: { bytes?: Uint8Array; size: number },
    source: PluginImportSource,
    opts: ActorOpts & {
      expect?: PluginPrepareExpect;
      provenance?: ReviewProvenance;
      /** The translation report: the plugin is a translated Claude Code plugin. */
      claude?: TranslationReport;
      /** The Claude manifest's `repository` (display only). */
      repository?: string;
      claudeManifestIgnored?: true;
    },
  ): Promise<{
    stagingId: string;
    review: PluginReview;
    permissionKeys: string[];
    permissionsMismatch: PermissionsMismatch;
  }> {
    const maxBytes = this.d.config().packages.maxBytes;

    // 1. Every check (nothing written)
    const m = pkg.manifest;
    const packageName = packageNameOf(pkg);
    const format: PluginSourceFormat = opts.claude !== undefined ? "claude-code" : "capybara";
    this.checkExpected(pkg, opts.expect, format);
    const bytes = tgz.bytes;
    if (m.extension && bytes === undefined) {
      throw new Error("an extension plugin is prepared from its package tgz");
    }
    const ext =
      m.extension && bytes !== undefined
        ? await readingPackage(() =>
            readExtensionPackage(bytes, { maxBytes, hostSdkVersion: SDK_VERSION }),
          )
        : undefined;
    const content = this.checkContent(pkg, format);
    const { existing, version } = await precheckCatalogImport(this.d.db, m.name, {
      packageName,
      version: m.version,
      contentDigest: pkg.contentDigest,
      ...(source.integrity !== undefined && { integrity: source.integrity }),
      ...(source.detail !== undefined && { detail: source.detail }),
      ...(source.marketplaceId !== undefined && { marketplaceId: source.marketplaceId }),
    });
    // The catalog name space is the extension name space: a declarative plugin cannot take a
    // config-declared or another package's extension name either
    this.assertNotDeclared(m.name);
    await assertPluginNameOwner(this.d.db, m.name, packageName);
    let extension: PluginReviewExtension | undefined;
    if (ext) {
      extension = await this.reviewExtension(
        ext,
        await this.extensionState(m.name, packageName as string),
      );
      await assertDowngradable(this.d.db, extension, ext.migrationSql);
    }
    if (content.files.length > 0) this.d.storage.assertAvailable();
    const src: PluginImportSource = {
      kind: source.kind,
      ref: source.ref,
      ...(source.integrity !== undefined && { integrity: source.integrity }),
      ...(source.marketplaceId !== undefined && { marketplaceId: source.marketplaceId }),
      ...(source.detail !== undefined && { detail: source.detail }),
    };
    const dependencies = await this.resolveDependencies(m);
    let translation: TranslationReport | undefined;
    if (opts.claude !== undefined) {
      const added: TranslationItem[] = [
        ...dependencies
          .filter((d) => d.resolved === null)
          .map((d) =>
            reportItem("dependency_not_imported", "plugin", d.name, {
              detail: { version: d.range },
            }),
          ),
        ...content.notLoaded.map((id) =>
          reportItem("connector_not_loaded", "mcpServer", id, {
            path: content.templatePaths.get(id) as string,
            detail: { connector: CLAUDE_MCP_CONNECTOR.plugin },
          }),
        ),
      ];
      translation = { ...opts.claude, items: sortItems([...opts.claude.items, ...added]) };
    }
    const license = licenseOf(pkg.files);
    const review: PluginReview = {
      name: m.name,
      format,
      ...(translation !== undefined && { translation }),
      ...(opts.claudeManifestIgnored === true && { claudeManifestIgnored: true as const }),
      ...(opts.repository !== undefined && { repository: opts.repository }),
      ...(license.text !== undefined && { licenseText: license.text }),
      ...(license.truncated && { licenseTruncated: true as const }),
      version,
      ...(version !== m.version && { pluginVersion: m.version }),
      contentDigest: pkg.contentDigest,
      packageName,
      publisher: m.publisher,
      description: m.description,
      ...(m.displayName !== undefined && { displayName: m.displayName }),
      ...(m.license !== undefined && { license: m.license }),
      ...(m.homepage !== undefined && { homepage: m.homepage }),
      ...(extension && { extension }),
      skills: content.skills,
      connectorTemplates: content.templates,
      ...(content.agentTemplates.length > 0 && { agentTemplates: content.agentTemplates }),
      dependencies,
      source: src,
      provenance: (opts.provenance ?? NOT_NPM).provenance,
      ...(opts.provenance?.warning !== undefined && { provenanceWarning: opts.provenance.warning }),
      sensitive: extension?.sensitive === true,
      reviewHash: "",
    };
    review.reviewHash = pluginReviewHash(review, content.files);
    // Re-check under the lock that the actor is still an enterprise admin before writing
    await this.d.db.transaction().execute(() => authorizeActor(this.d.adminLock, actor));

    // 2. Write: the extension into the package store, files into object storage, the staging row
    const stagingId = randomUUID();
    const itemId = existing?.id ?? randomUUID();
    if (ext) {
      const bootstrap = src.kind === "bootstrap";
      await this.d.installs.ingest(
        actor,
        bytes as Uint8Array,
        bootstrap
          ? { source: "bootstrap", ref: src.ref }
          : {
              source: "catalog",
              ref: src.marketplaceId !== undefined ? `catalog:${src.ref}` : `${itemId}@${version}`,
            },
        {
          ...(opts.actorTokenId !== undefined && { actorTokenId: opts.actorTokenId }),
          ...(bootstrap && { store: "pg" as const }),
        },
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
      contentDigest: pkg.contentDigest,
      size: tgz.size,
      manifest: normalizedManifest(pkg),
      files: content.files.map(({ path, size, sha256 }) => ({ path, size, sha256 })),
      ...(mismatch !== null && { permissionsMismatch: mismatch }),
      sourceFormat: format,
      ...(translation !== undefined && { translation }),
      ...(license.text !== undefined && { licenseText: license.text }),
      ...(license.truncated && { licenseTruncated: true as const }),
    };
    await this.d.db.transaction().execute(async (trx) => {
      await authorizeActor(this.d.adminLock, actor);
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
        ...(actor !== null && { actorAccountId: actor }),
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
    actor: string | null,
    input: { package: string; version?: string },
    opts: ActorOpts = {},
  ): Promise<{ stagingId: string; review: PluginReview }> {
    const got = await this.d.installs.fetchNpm(input);
    const provenance = await this.d.installs.fetchProvenance({
      package: input.package,
      version: got.version,
      integrity: got.integrity,
    });
    const r = await this.prepare(
      actor,
      got.bytes,
      {
        kind: "npm",
        ref: `${input.package}@${got.version}`,
        integrity: got.integrity,
        detail: { registry: new URL(this.d.config().packages.npmRegistry).origin },
      },
      { ...opts, expect: { packageName: input.package }, provenance: { provenance } },
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
    actor: string | null,
    stagingId: string,
    input: {
      reviewHash: string;
      deployExtension: boolean;
      /**
       * With `deployExtension`: enable the extension after installing it (default true). false
       * keeps the install record's desired state (a new install stays disabled), for the bootstrap
       * step's upgrades of a plugin an enterprise admin may have disabled.
       */
      enable?: boolean;
      /**
       * The skills (by name, each in the review) suggested as pinned when an agent selects them
       * (spec §9.1); replaces the plugin's `pinned` flags in the stored manifest. Omitted keeps
       * them. An admin decision like `deployExtension`, so not part of `reviewHash`.
       */
      pinnedSuggestions?: string[];
    },
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
    const manifest = withPinned(staged.manifest, review, input.pinnedSuggestions);
    const reviewed = review.extension;
    // Read the stored package outside the transaction (unless it was already installed as is)
    const stored =
      reviewed && reviewed.action !== "keep" ? await this.readStored(reviewed.sha256) : undefined;

    const committed = await this.d.db.transaction().execute(async (trx) => {
      await authorizeActor(this.d.adminLock, actor);
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
            await this.extensionState(reviewed.name, staged.packageName as string, trx),
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
      const m = manifest;
      const itemId = await writeCatalogVersion(trx, {
        actor,
        ...(opts.actorTokenId !== undefined && { actorTokenId: opts.actorTokenId }),
        name: m.name,
        packageName: staged.packageName,
        version: staged.version,
        contentDigest: staged.contentDigest,
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
          ...(src.detail !== undefined && { detail: src.detail }),
        },
        ...(src.marketplaceId !== undefined && { marketplaceId: src.marketplaceId }),
        objectPrefix: row.object_prefix,
        extensionSha256: reviewed?.sha256 ?? null,
        files: staged.files,
        size: staged.size,
        sourceFormat: staged.sourceFormat ?? "capybara",
        translation: staged.translation ?? null,
        licenseText: staged.licenseText ?? null,
        licenseTruncated: staged.licenseTruncated === true,
        auditDetail: {
          stagingId,
          deployExtension: input.deployExtension,
          suggestedPinned: pinnedNames(manifest, review),
          ...(now && { extension: { name: now.name, version: now.version, action: now.action } }),
        },
      });
      return { itemId, now, previous };
    });

    const { now } = committed;
    const deploy =
      input.deployExtension && now && now.action !== "keep"
        ? await this.deploy(
            actor,
            review,
            committed.itemId,
            now,
            committed.previous,
            opts,
            input.enable ?? true,
          )
        : null;
    return { item: await this.itemView(committed.itemId), deploy };
  }

  /**
   * Writes the extension's permission snapshot for the version being imported (source web; cli
   * without an actor; bootstrap for the bootstrap step), after
   * registering the name owner like ExtensionAdminOps.install (Ruling P3). Returns the snapshot it
   * overwrote (null when there was none).
   */
  private async approve(
    trx: Trx,
    actor: string | null,
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
      .values({ name: p.name, package_name: staged.packageName as string })
      .onConflict((oc) => oc.column("name").doNothing())
      .execute();
    await assertPluginNameOwner(trx, p.name, staged.packageName);
    const { added, removed } = diffPermissions(
      snapRow?.permissions as PermissionSet | undefined,
      set,
    );
    await writeSnapshot(trx, p.name, p.version, set, {
      source: review.source.kind === "bootstrap" ? "bootstrap" : actor === null ? "cli" : "web",
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
    actor: string | null,
    review: PluginReview,
    itemId: string,
    p: PluginReviewExtension,
    previous: PreviousSnapshot | null | undefined,
    opts: ActorOpts,
    enable: boolean,
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
    if (!enable) return { ...base, result: "installed" };
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
    actor: string | null,
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
        ...(actor !== null && { actorAccountId: actor }),
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
  private checkExpected(
    pkg: PluginContents,
    expect: PluginPrepareExpect | undefined,
    format: PluginSourceFormat = "capybara",
  ): void {
    const packageName = packageNameOf(pkg);
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
    // Claude Code's rule: plugin.json's version wins over the entry's (spec §5.3 order)
    if (e.version !== null && format === "capybara" && pkg.manifest.version !== e.version) {
      throw mismatch(
        `the plugin's version is ${pkg.manifest.version}, the entry says ${e.version}`,
      );
    }
  }

  /** A config-declared extension's name cannot be taken by an imported plugin. */
  private assertNotDeclared(name: string): void {
    const declared = this.d.declared().get(name);
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
  private checkContent(
    pkg: PluginContents,
    format: PluginSourceFormat = "capybara",
  ): {
    files: SkillPackageFile[];
    templates: PluginReviewTemplate[];
    skills: PluginReview["skills"];
    agentTemplates: PluginReviewAgentTemplate[];
    /** Translated templates whose connector is not loaded (static checks only, Decisions 2). */
    notLoaded: string[];
    /** Template id -> path. */
    templatePaths: Map<string, string>;
  } {
    const m = pkg.manifest;
    const notLoaded: string[] = [];
    const templatePaths = new Map<string, string>();
    const pinned = new Map((m.skills ?? []).map((s) => [packagePath(s.path), s.pinned === true]));
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
        // A translated Claude Code plugin keeps its SKILL.md files as written: their invocation
        // keys are read leniently (the translation report lists the ones ignored)
        const invocationKeys = format !== "claude-code";
        const r = checkSkillFiles(files, { invocationKeys });
        const md = parseSkillMd(
          new TextDecoder().decode(pkg.files.get(`${s.dir}/${SKILL_ENTRY_FILE}`)),
          { invocationKeys },
        );
        skills.push({
          name: r.name,
          description: r.description,
          body: "errors" in md ? "" : md.body,
          path: `./${s.dir}`,
          files: files.length,
          suggestPinned: pinned.get(s.dir) === true,
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
        if (
          t.pluginVersion !== undefined &&
          v !== undefined &&
          !satisfiesRange(v, t.pluginVersion)
        ) {
          problems.push(
            `${at}.pluginVersion: extension ${t.plugin} is loaded at version ${v}, which does not satisfy ${t.pluginVersion}`,
          );
        }
      } else if (
        local.has(t.plugin) ||
        this.d.connectorsLoaded === false ||
        (format === "claude-code" && t.plugin === CLAUDE_MCP_CONNECTOR.plugin)
      ) {
        // The connector comes with this plugin or a dependency (or this process loads no
        // connectors, or a translated Claude template targets connector-mcp, which may not be
        // loaded: Decisions 2): static checks only now
        for (const leak of endpointCredentialIssues(t.endpoint)) {
          problems.push(`${at}.${leak.path}: ${leak.message}`);
        }
        if (format === "claude-code") notLoaded.push(c.id);
      } else {
        problems.push(
          `${at}.connector: extension ${t.plugin} providing connector "${t.connector}" is not loaded in this deployment and is neither this plugin's extension nor a dependency`,
        );
      }
      keep(c.path);
      templatePaths.set(c.id, c.path);
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
    const agentTemplates: PluginReviewAgentTemplate[] = pkg.agentTemplates.map((a) => {
      keep(a.path);
      const { name, description, instructions, model, ...rest } = a.template;
      return { name, path: a.path, description, instructions, model: model ?? "inherit", ...rest };
    });
    if (problems.length > 0) throw invalid(problems);
    return {
      files: [...stored.values()],
      templates,
      skills,
      agentTemplates,
      notLoaded,
      templatePaths,
    };
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
      .select(["i.name", "v.version", "v.imported_at"])
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
        maxSatisfying(
          rows
            .filter((r) => r.name === d.name)
            .map((r) => ({ version: r.version, importedAt: r.imported_at })),
          d.version,
        )?.version ?? null,
    }));
  }

  /**
   * The extension's state on the deployment; installed from another npm package ->
   * `extension.name_conflict`.
   */
  private async extensionState(
    name: string,
    packageName: string,
    db: KernelSchemaDb | Trx = this.d.db,
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
      .select(["version", "source", "imported_at"])
      .where("item_id", "=", itemId)
      .execute();
    return itemView(item, versions);
  }
}

/**
 * plugin.json as stored on the version: skills and connector templates listed explicitly (what was
 * scanned when the manifest omitted them), `pinned` kept from the listing.
 */
function normalizedManifest(pkg: PluginContents): PluginManifest {
  const pinned = new Map(
    (pkg.manifest.skills ?? []).map((s) => [packagePath(s.path), s.pinned] as const),
  );
  const { agents: _, ...manifest } = pkg.manifest;
  return {
    ...manifest,
    skills: pkg.skills.map((s) => {
      const p = pinned.get(s.dir);
      return { path: `./${s.dir}`, ...(p !== undefined && { pinned: p }) };
    }),
    connectorTemplates: pkg.connectorTemplates.map((t) => ({ path: `./${t.path}` })),
    // listed only when there are any, so the stored manifests of other plugins stay as they were
    ...(pkg.agentTemplates.length > 0 && {
      agents: pkg.agentTemplates.map((a) => ({ path: `./${a.path}` })),
    }),
  };
}

/** package.json `name`, or null without one (a git plugin; never the string "undefined"). */
function packageNameOf(pkg: PluginContents): string | null {
  const name = pkg.packageJson.name;
  return typeof name === "string" ? name : null;
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
 * The review digest (first 32 hex of a sha256): name, version and content digest, the extension (sha256, action,
 * current version / package, its own review digest), every template field, each skill's name / path
 * / file count, the dependency resolution, the sha256 of every stored file, the format, the
 * translation report's items, the sha256 of the license text and the two review flags
 * (`claudeManifestIgnored`, `licenseTruncated`), and the agent templates when there are any.
 * Exported for tests. `repository` is display only.
 */
export function pluginReviewHash(
  r: Pick<
    PluginReview,
    | "name"
    | "version"
    | "contentDigest"
    | "extension"
    | "connectorTemplates"
    | "agentTemplates"
    | "skills"
    | "dependencies"
    | "format"
    | "translation"
    | "licenseText"
    | "claudeManifestIgnored"
    | "licenseTruncated"
  >,
  files: { path: string; sha256: string }[],
): string {
  const e = r.extension;
  const lic = r.licenseText;
  const canonical = JSON.stringify([
    r.name,
    r.version,
    r.contentDigest,
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
    // phase B: the format, the translation report (in report order) and the license text
    r.format,
    r.translation?.items.map((i) => [i.group, i.component, i.name, i.path, i.code, i.detail]) ??
      null,
    lic !== undefined ? createHash("sha256").update(lic).digest("hex") : null,
    r.claudeManifestIgnored === true,
    r.licenseTruncated === true,
    // phase C: agent templates, only when there are any (earlier digests stay the same)
    ...((r.agentTemplates ?? []).length > 0
      ? [(r.agentTemplates ?? []).map((a) => [a.path, canonicalJson(a)])]
      : []),
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
  db: KernelSchemaDb | Trx,
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

/** The root license text (spec §8.4; any plugin): the first of {@link LICENSE_FILES}, UTF-8. */
function licenseOf(files: ReadonlyMap<string, Uint8Array>): { text?: string; truncated: boolean } {
  for (const f of LICENSE_FILES) {
    const data = files.get(f);
    if (data === undefined) continue;
    if (data.byteLength > LICENSE_TEXT_MAX_BYTES) return { truncated: true };
    try {
      return { text: new TextDecoder("utf-8", { fatal: true }).decode(data), truncated: false };
    } catch {
      return { truncated: true };
    }
  }
  return { truncated: false };
}

/**
 * The manifest with the confirm's suggested pinning: `names` (each a skill of the review, else
 * `validation_failed`) marks those skills `pinned: true` and clears the flag on the others;
 * undefined keeps the plugin's flags.
 */
function withPinned(
  m: PluginManifest,
  review: PluginReview,
  names: string[] | undefined,
): PluginManifest {
  if (names === undefined) return m;
  const byName = new Map(review.skills.map((s) => [s.name, s.path] as const));
  const unknown = names.filter((n) => !byName.has(n));
  if (unknown.length > 0) {
    throw new ApiError(
      "validation_failed",
      `pinnedSuggestions: ${unknown.map((n) => JSON.stringify(n)).join(", ")} ${unknown.length === 1 ? "is not a skill" : "are not skills"} of this plugin`,
    );
  }
  const paths = new Set(names.map((n) => byName.get(n)));
  return {
    ...m,
    skills: (m.skills ?? []).map(({ pinned: _, ...s }) =>
      paths.has(s.path) ? { ...s, pinned: true } : s,
    ),
  };
}

/** Names of the skills the stored manifest suggests pinning (for the audit). */
function pinnedNames(m: PluginManifest, review: PluginReview): string[] {
  const byPath = new Map(review.skills.map((s) => [s.path, s.name] as const));
  return (m.skills ?? []).filter((s) => s.pinned === true).map((s) => byPath.get(s.path) ?? s.path);
}
