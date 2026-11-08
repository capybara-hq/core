import { createHash, randomUUID } from "node:crypto";
import {
  type AgentTemplate,
  type AgentTemplateTier,
  type ConnectorTemplateSpec,
  type LocalizedName,
  PLUGIN_MANIFEST_FILE,
  type PluginManifest,
  parseSkillMd,
  pluginDescription,
  SDK_VERSION,
  SKILL_ENTRY_FILE,
  type ThemeScheme,
} from "@capybara-hq/plugin-sdk";
import { getQueueToken } from "@nestjs/bullmq";
import { Inject, Injectable } from "@nestjs/common";
import type { Queue } from "bullmq";
import { type ExpressionBuilder, sql } from "kysely";
import semver from "semver";
import type { KernelDatabase, KernelSchemaDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { ExtensionAdminOps, type InstallView } from "../extensions/admin-ops.js";
import { ExtensionAdmin } from "../extensions/admin-view.js";
import { writeSnapshot } from "../extensions/approvals.js";
import { blobKey, ExtensionBlobs } from "../extensions/blobs.js";
import { ExtensionInstalls } from "../extensions/installs.js";
import { PluginApproveLock, PluginInstallLock } from "../extensions/locks.js";
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
import { ExtensionRegistry } from "../extensions/registry.js";
import type { SingleProviderBlock } from "../extensions/single-provider.js";
import { audit } from "../identity/audit.js";
import { assertCustomAllowed } from "../identity/settings.js";
import { SuperAdminLock } from "../identity/super-admin.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { afterCommit } from "../infra/database/after-commit.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { OrgLock } from "../orgs/org-lock.js";
import type { ProvenanceResult } from "../packages/provenance.js";
import { packPackageTgz } from "../packages/tgz.js";
import { MAINTENANCE_QUEUE_NAME } from "../runtime/maintenance-queue.js";
import { checkSkillFiles, SkillArchiveError, type SkillPackageFile } from "../skills/package.js";
import { type PrefixedStorage, StorageService } from "../storage/storage.service.js";
import { canonicalJson } from "../tools/canonical-json.js";
import { endpointCredentialIssues } from "../tools/endpoint.js";
import type {
  ActorOpts,
  CatalogItemView,
  PermissionsMismatch,
  SourceDetail,
} from "./catalog.service.js";
import { findConnectorIn } from "./catalog-content.js";
import { displayFilePaths, putDisplayFiles, sweepDisplayFiles } from "./catalog-files.js";
import {
  assertOrgsExist,
  assertPluginNameOwner,
  catalogObjectPrefix,
  itemConfirmations,
  itemScopeFacts,
  itemView,
  markVersionApplied,
  permissionsMismatch,
  precheckCatalogImport,
  putCatalogFiles,
  templateProblems,
  unappliedOwnVersion,
  writeCatalogVersion,
} from "./catalog-items.js";
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
import { CatalogItemLock } from "./locks.js";
import {
  assertNameFree,
  assertPackageFree,
  assertShareable,
  packageOwner,
  releaseExtensionClaim,
  shareGate,
  usableBy,
} from "./ownership.js";
import { PlatformComponents } from "./platform-components.js";
import { PLATFORM_MIGRATION_JOB } from "./platform-migration.js";
import {
  type PluginContents,
  PluginPackageError,
  packagePath,
  readPluginFiles,
  readPluginPackage,
  themeApiError,
} from "./plugin-package.js";
import { hasImportRequests, importRequestOf, resolveImportRequests } from "./request-rules.js";
import { assertNameNotReserved } from "./reserved-names.js";
import type { PluginScope } from "./scope.js";
import { addScopeOrg } from "./scope-orgs.js";
import { maxSatisfying, satisfiesRange } from "./versions.js";

/** How long after a failed post-import platform sync the migration job runs for the item. */
export const PLATFORM_SYNC_RETRY_MS = 60_000;

/**
 * Platform import of a plugin (package ecosystem spec §4.3): one review for every plugin, whatever
 * it contains (an extension, skills, connector templates, dependencies), confirmed once.
 *
 * prepare: the tgz is always hostile input, and **nothing is written until every check passes**
 * (F-AD): `readPluginPackage` (plugin.json, package.json, listed / scanned skills and templates,
 * icons; a pre-0.1.0 tgz is `catalog.legacy_format`), the extension's module graph and migrations
 * (`readExtensionPackage`), the extension's deployment state (config-declared names are
 * refused; name ownership; a downgrade to a version with unrun migrations is refused), each skill by
 * the skill package rules, each connector template against the connector loaded on this replica (or
 * statically when the connector is provided by the plugin's own extension or by a dependency), the
 * catalog name / version conflicts and the actor still a super admin. Dependencies are only
 * resolved against the imported catalog versions for the review (an unresolved one does not block
 * the import, spec §4.1); they are never fetched. Only then is the extension handed to
 * `ExtensionInstalls.ingest` (source `catalog`), the skill / template files written to object
 * storage, the display files (icons, setup guide files; `catalog-files.ts`) written to PG with a
 * staging row (24 hours), and `catalog.plugin_staged` audited. A display file inside a skill
 * directory or at a template's path goes to both places: each reader finds it where it looks.
 *
 * confirm: `reviewHash` must match the staging; in one transaction it deletes the staging row
 * (confirm works once), locks the extension name and recomputes its deployment state (installed /
 * upgraded / swapped after the review -> `plugin.review_stale`), writes the extension's permission
 * snapshot when it is installed or upgraded by this import (source web, audit
 * `extension.permissions_approved` carrying the plugin), and creates the item (with the scope the
 * admin chose, default `optional`) or adds the version (`manifest` = the normalized plugin.json,
 * `extension_sha256`, the files under the staging prefix). After the commit the plugin's own
 * extension is installed on the deployment and enabled (`ExtensionAdminOps.install` + `enable`;
 * each replica reconciles, no restart); a failure is returned, not thrown, and an upgrade that was
 * not installed gets its old snapshot back.
 *
 * Expired staging is cleaned by the maintenance job `app-staging-cleanup`
 * ({@link PluginImport.cleanupExpired}): it deletes the staging row and its object prefix, then the
 * display files (`catalog_files`) nothing lists any more; a stored extension package stays in the
 * content-addressed `extension_packages` (the same as importing the same tgz again; without an
 * install record referencing it it is never loaded).
 */

/** How long a staged import is kept. */
export const PLUGIN_STAGING_TTL_MS = 24 * 3600_000;
/** Staging rows cleaned per batch. */
const CLEANUP_BATCH = 100;

/** The deployment state of the plugin's extension and what confirming does with it. */
export type ExtensionReviewAction = "install" | "upgrade" | "keep";

/** The plugin's extension in a review. */
export interface PluginReviewExtension {
  name: string;
  version: string;
  /** sha256 of the plugin tgz (the package store key). */
  sha256: string;
  /**
   * install: not on the deployment; upgrade: installed from another package whose version is not
   * above the import's, the import's package replaces it when confirmed; keep: this exact package is
   * installed, or the installed version is newer (`olderThanDeployed`): the confirm records the
   * version in the catalog only and never downgrades the deployment.
   */
  action: ExtensionReviewAction;
  /**
   * The import's version is below the one deployed: the review warns that confirming keeps the
   * deployed extension (action `keep`); absent otherwise.
   */
  olderThanDeployed?: true;
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

/** One theme in a review (themes spec §6): what the super admin sees before confirming. */
export interface PluginReviewTheme {
  /** The theme id (the file's base name). */
  id: string;
  name: LocalizedName;
  /** The schemes it defines. */
  schemes: ThemeScheme[];
  /** Number of fonts. */
  fonts: number;
  /** It replaces the logo mark, the wordmark or the favicon. */
  logo: boolean;
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

/**
 * An org upload (spec §14, rulings P3-7, P3-8): the org that will own the plugin. Its admin is
 * authorized (`catalog.upload`) instead of the super admin, its staging is its own, and the new
 * item is owned by it with scope `named: [orgId]`.
 */
export interface ImportOwner {
  orgId: string;
}

/** The format a plugin was read from: a Capybara plugin, or a translated Claude Code plugin. */
export type PluginSourceFormat = "capybara" | "claude-code";

/** Root license files, in the order they are looked for. */
const LICENSE_FILES = ["LICENSE", "LICENSE.md", "LICENSE.txt", "LICENCE"] as const;
/** The largest license text stored (bytes); a longer one is omitted (`licenseTruncated`). */
export const LICENSE_TEXT_MAX_BYTES = 65536;

/** The one review of a plugin (the super admin sees every component before confirming). */
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
  /** The plugin.json description's English text (a plain string description is English). */
  description: string;
  /** Its Chinese text (`description.zh`); null without one. */
  descriptionZh: string | null;
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
   * Themes (themes spec §6). Absent without any; left out of {@link pluginReviewHash} when empty,
   * so the digests of plugins without themes are unchanged.
   */
  themes?: PluginReviewTheme[];
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

/** The deploy result of the plugin's extension at confirm. */
export interface ExtensionDeployResult {
  name: string;
  action: "install" | "upgrade";
  version: string;
  /** The package to install (retry through the extension admin with it after a failure). */
  sha256: string;
  /**
   * enabled: installed and enabled; installed: installed, desired state left as it was (confirm
   * with `enable: false`, the bootstrap step's upgrades), or left disabled because a
   * single-provider extension point is taken (code / message / `singleProvider` say so); failed:
   * see code / message.
   */
  result: "enabled" | "installed" | "failed";
  code?: string;
  message?: string;
  /**
   * Installed but left disabled (result `installed`, code `extension.single_provider_enabled`, or
   * `extension.single_provider_required` when the holder is a required plugin): another enabled
   * extension provides a single-provider extension point this one provides (a new install, or an
   * upgrade whose new version newly provides it). The super admin disables that one, then enables
   * this one; a required holder cannot be replaced.
   */
  singleProvider?: SingleProviderBlock;
  /** e.g. `snapshot_not_restored: …` when an upgrade failed and the snapshot had changed since. */
  note?: string;
}

/** The result of {@link PluginImport.confirm}. */
export interface PluginConfirmResult {
  item: CatalogItemView;
  /** This confirm created the item (a first import of the name), else it added a version. */
  created: boolean;
  /** null when there is nothing to deploy (no extension, or keep). */
  deploy: ExtensionDeployResult | null;
  /**
   * An org upload with an extension: the version waits for the super admin's confirmation
   * (ruling P3-10); nothing was approved, installed or synced.
   */
  pending: boolean;
  /**
   * The confirm made the item's first usable version: it created the item, or it replaced an org
   * upload's first version that was still waiting for the super admin with a version without an
   * extension (applied at once, plan Task 6).
   */
  firstVersion: boolean;
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
  /**
   * An org's own version already imported but not applied (pre-flight F4): the confirm writes no
   * version (the caller retries the update); no files are staged.
   */
  retry?: true;
}

/** What an org's staged upload targets (see {@link PluginImport.stagedTarget}). */
export interface StagedTarget {
  itemId: string;
  version: string;
  /** The review's own hash (an org's review of an update shows a combined one, P3-12). */
  reviewHash: string;
  /** The review has an extension. */
  extension: boolean;
  /** The live item exists already (a new version), owned by the staging's org. */
  existing: boolean;
  /** That item's first version still waits for the super admin (P3-9). */
  awaiting: boolean;
  /** The version is imported already (pre-flight F4). */
  retry: boolean;
  /** The target as the platform updater reads it (the staged manifest and files). */
  target: {
    version: string;
    manifest: PluginManifest;
    object_prefix: string | null;
    files: { path: string; size: number; sha256: string }[];
    extension_sha256: string | null;
  };
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
const reviewStale = (review: { name: string; version: string }) =>
  new ApiError(
    "plugin.review_stale",
    `The review of plugin ${review.name} ${review.version} is out of date (it changed, or its extension on this deployment changed since it was prepared); review it again`,
  );
const mismatch = (what: string) =>
  new ApiError(
    "marketplace.package_mismatch",
    `The downloaded package does not match the marketplace entry: ${what}`,
  );

/**
 * The API error of a plugin package that cannot be read in a catalog path: the pre-0.1.0 format ->
 * `catalog.legacy_format`; a failing theme (themes spec §5) -> `theme.invalid` (details
 * `[{ theme, errors }]`) or `theme.unreadable` (details `[{ theme, issues }]`, the failing pairs);
 * anything else -> `catalog.invalid_manifest` (issues as details).
 */
export function catalogPackageError(e: PluginPackageError | ExtensionPackageError): ApiError {
  const legacy = e.code === "catalog.legacy_format" || e.code === "extension.legacy_format";
  if (legacy) return new ApiError("catalog.legacy_format", e.message, e.issues);
  if (e.code === "theme.invalid" || e.code === "theme.unreadable") {
    return themeApiError(e as PluginPackageError);
  }
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

/** The deployment state of the plugin's extension. */
type ExtensionState =
  | { kind: "installed"; version: string; sha256: string; packageName: string }
  | { kind: "absent" };

@Injectable()
export class PluginImport {
  /** Where plugin files go (the kernel's object storage; the CLI's own, see {@link useCliStorage}). */
  private files: PrefixedStorage;
  /**
   * false: this process loads no connectors (the CLI), so a template of an unknown connector gets
   * only the static endpoint checks and `endpointChecked: false`; the org install re-checks it
   * against the loaded connector.
   */
  private connectorsLoaded = true;

  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    /** The super admin lock (identity/super-admin.ts): joins the caller's transaction. */
    @Inject(SuperAdminLock) private readonly adminLock: SuperAdminLock,
    /** The owner org's lock: an org upload re-checks its admin under it (ruling P3-7). */
    @Inject(OrgLock) private readonly orgLock: OrgLock,
    @Inject(PluginInstallLock) private readonly installLock: PluginInstallLock,
    @Inject(PluginApproveLock) private readonly approveLock: PluginApproveLock,
    @Inject(CatalogItemLock) private readonly itemLock: CatalogItemLock,
    @Inject(KernelConfigService) private readonly config: KernelConfigService,
    @Inject(StorageService) storage: StorageService,
    @Inject(ExtensionInstalls) private readonly installs: ExtensionInstalls,
    @Inject(ExtensionAdminOps) private readonly ops: ExtensionAdminOps,
    @Inject(ExtensionAdmin) private readonly admin: ExtensionAdmin,
    /** Reads a package from the package store (confirm recomputes the permission set). */
    @Inject(ExtensionBlobs) private readonly blobs: ExtensionBlobs,
    /** Config-declared names, loaded connectors and extension versions (the extension registry). */
    @Inject(ExtensionRegistry) private readonly registry: ExtensionRegistry,
    @Inject(KERNEL_LOGGER) private readonly log: KernelLogger,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    /** The platform rows of a new item's components, written after the confirm's commit. */
    @Inject(PlatformComponents) private readonly platform: PlatformComponents,
    /** A failed platform sync enqueues a run of the migration job here (it heals the item). */
    @Inject(getQueueToken(MAINTENANCE_QUEUE_NAME)) private readonly maintenance: Pick<Queue, "add">,
  ) {
    this.files = storage;
  }

  /** The kernel-schema handle of the current context (the transaction, else the pool). */
  private get db(): KernelSchemaDb {
    return this.kdb.db;
  }

  /**
   * CLI only (like `ExtensionHost.noteInspected`): plugin files go to the object store the CLI set
   * up itself, and connector templates get static checks only (the CLI loads no connector). Called
   * once, right after the command's context is created.
   */
  useCliStorage(storage: PrefixedStorage): void {
    this.files = storage;
    this.connectorsLoaded = false;
    this.platform.useCliStorage(storage);
  }

  /**
   * The super-admin re-check under the lock, in the caller's transaction. `actor` null is the
   * CLI (the operator of the deployment: no account to re-check, audits carry no actor), like
   * `ExtensionInstalls.ingest`. An org upload (`owner`) re-checks the actor as an admin of the
   * owner org under the org row lock instead (`catalog.upload`; an org deleted meanwhile -> 404
   * `org.not_found`).
   */
  @Transactional({ propagation: "mandatory" })
  private async authorizeActor(actor: string | null, owner?: ImportOwner): Promise<void> {
    if (owner !== undefined) {
      if (actor === null) throw new Error("an org upload has an actor");
      await this.orgLock.lockAndAuthorize(owner.orgId, actor, "catalog.upload");
    } else if (actor === null) await this.adminLock.lock();
    else await this.adminLock.lockAndAuthorize(actor);
  }

  /** The re-check alone, in a transaction of its own (before anything is written). */
  @Transactional()
  private async authorize(actor: string | null, owner?: ImportOwner): Promise<void> {
    await this.authorizeActor(actor, owner);
  }

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
      /** An org upload (a `file` source only, ruling P3-7). */
      owner?: ImportOwner;
    } = {},
  ): Promise<{
    stagingId: string;
    review: PluginReview;
    permissionKeys: string[];
    permissionsMismatch: PermissionsMismatch;
  }> {
    const maxBytes = this.config.get().packages.maxBytes;
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
          allowInsecureLoopback: this.config.get().marketplaces.allowInsecureLoopback,
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
      owner?: ImportOwner;
    },
  ): Promise<{
    stagingId: string;
    review: PluginReview;
    permissionKeys: string[];
    permissionsMismatch: PermissionsMismatch;
  }> {
    const maxBytes = this.config.get().packages.maxBytes;
    const owner = opts.owner;
    if (owner !== undefined && source.kind !== "file") {
      throw new Error("an org upload is a file (ruling P3-7)");
    }

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
    // A name live for another owner (an org's for the super admin; the platform's or another
    // org's for an org) -> 409 plugin.name_taken naming it (P3-14); the same owner adds a version
    await assertNameFree(this.db, m.name, owner?.orgId ?? null);
    if (owner !== undefined) {
      // a bootstrap or marketplace plugin's name stays free for the platform (ruling P3-28)
      await assertNameNotReserved(this.db, m.name);
      // its npm package is an identity of this org only (ruling P3-51)
      await assertPackageFree(this.db, packageName, owner.orgId);
      await assertCustomContent(this.db, content);
    }
    // An org's own version imported but not applied: its update is retried (pre-flight F4)
    const retry =
      owner !== undefined && !m.extension
        ? await unappliedOwnVersion(this.db, m.name, owner.orgId, {
            packageName,
            version: m.version,
            contentDigest: pkg.contentDigest,
          })
        : undefined;
    const { existing, version } =
      retry !== undefined
        ? { existing: { id: retry.itemId }, version: retry.version }
        : await precheckCatalogImport(this.db, m.name, {
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
    await assertPluginNameOwner(this.db, m.name, packageName);
    let extension: PluginReviewExtension | undefined;
    if (ext) {
      extension = await this.reviewExtension(
        ext,
        await this.extensionState(m.name, packageName as string),
      );
      await assertDowngradable(this.db, extension, ext.migrationSql);
    }
    // Display files go to PG with the staging row; skills and templates need object storage, which a
    // bootstrap import never has (the object store may be a bootstrap plugin itself). A file that is
    // both (an icon inside a skill directory) goes to both: the readers of each look only there
    const displayFiles = content.files.filter((f) => content.displayPaths.has(f.path));
    const objectFiles = content.files.filter((f) => content.objectPaths.has(f.path));
    if (objectFiles.length > 0 && retry === undefined) {
      if (source.kind === "bootstrap" && !this.files.available) {
        throw new ApiError(
          "storage.unavailable",
          `Bootstrap plugin ${m.name} ships skills, connector templates, agent templates or themes, which are kept in object storage, and object storage is not running yet (it may be a bootstrap plugin itself); a required bootstrap plugin may ship only an icon and setup guides, an optional one is retried once the extensions have loaded`,
        );
      }
      this.files.assertAvailable();
    }
    const src: PluginImportSource = {
      kind: source.kind,
      ref: source.ref,
      ...(source.integrity !== undefined && { integrity: source.integrity }),
      ...(source.marketplaceId !== undefined && { marketplaceId: source.marketplaceId }),
      ...(source.detail !== undefined && { detail: source.detail }),
    };
    const dependencies = await this.resolveDependencies(m, owner);
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
      description: pluginDescription(m.description).en,
      descriptionZh: pluginDescription(m.description).zh ?? null,
      ...(m.displayName !== undefined && { displayName: m.displayName }),
      ...(m.license !== undefined && { license: m.license }),
      ...(m.homepage !== undefined && { homepage: m.homepage }),
      ...(extension && { extension }),
      skills: content.skills,
      connectorTemplates: content.templates,
      ...(content.agentTemplates.length > 0 && { agentTemplates: content.agentTemplates }),
      ...(content.themes.length > 0 && { themes: content.themes }),
      dependencies,
      source: src,
      provenance: (opts.provenance ?? NOT_NPM).provenance,
      ...(opts.provenance?.warning !== undefined && { provenanceWarning: opts.provenance.warning }),
      sensitive: extension?.sensitive === true,
      reviewHash: "",
    };
    review.reviewHash = pluginReviewHash(review, content.files);
    // Re-check under the lock that the actor is still a super admin (an org upload: an admin of
    // the owner org) before writing
    await this.authorize(actor, owner);

    // 2. Write: the extension into the package store, files into object storage, the staging row
    const stagingId = randomUUID();
    const itemId = existing?.id ?? randomUUID();
    if (ext) {
      const bootstrap = src.kind === "bootstrap";
      await this.installs.ingest(
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
          // an org upload only stores the package (nothing runs until the super admin confirms)
          ...(owner !== undefined && { owner }),
        },
      );
    }
    let objectPrefix: string | null = null;
    if (objectFiles.length > 0 && retry === undefined) {
      objectPrefix = catalogObjectPrefix(itemId, version, stagingId);
      await putCatalogFiles(this.files, objectPrefix, objectFiles);
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
      ...(retry !== undefined && { retry: true as const }),
    };
    await this.writeStaging(
      actor,
      stagingId,
      review,
      staged,
      objectPrefix,
      src,
      opts,
      owner,
      displayFiles,
    );
    return { stagingId, review, permissionKeys: keys, permissionsMismatch: mismatch };
  }

  /** The staging row and the `catalog.plugin_staged` audit, the actor re-checked under the lock. */
  @Transactional()
  private async writeStaging(
    actor: string | null,
    stagingId: string,
    review: PluginReview,
    staged: StagedPlugin,
    objectPrefix: string | null,
    src: PluginImportSource,
    opts: ActorOpts,
    owner: ImportOwner | undefined,
    displayFiles: { sha256: string; data: Uint8Array }[],
  ): Promise<void> {
    const { extension } = review;
    const t = this.db;
    await this.authorizeActor(actor, owner);
    // committed with the staging row that lists them (the sweep keeps what a staging lists)
    await putDisplayFiles(t, displayFiles);
    await t
      .insertInto("plugin_import_staging")
      .values({
        id: stagingId,
        review: JSON.stringify(review),
        manifest: JSON.stringify(staged),
        object_prefix: objectPrefix,
        source: JSON.stringify(src),
        created_by: actor,
        expires_at: new Date(Date.now() + PLUGIN_STAGING_TTL_MS),
        // the org's own staging (P3-8); null = the super admin's
        org_id: owner?.orgId ?? null,
      })
      .execute();
    await audit(t, {
      ...(actor !== null && { actorAccountId: actor }),
      ...(opts.actorTokenId !== undefined && { actorTokenId: opts.actorTokenId }),
      action: "catalog.plugin_staged",
      target: stagingId,
      detail: {
        stagingId,
        name: review.name,
        version: staged.version,
        source: src.kind,
        sourceRef: src.ref,
        ...(src.integrity !== undefined && { integrity: src.integrity }),
        ...(src.marketplaceId !== undefined && { marketplaceId: src.marketplaceId }),
        reviewHash: review.reviewHash,
        ...(extension && {
          extension: { sha256: extension.sha256, action: extension.action },
        }),
        ...(owner !== undefined && { orgId: owner.orgId }),
        ...opts.auditDetail,
      },
    });
  }

  /** Fetches a plugin from the configured npm registry (verified by `dist.integrity`), then prepares it. */
  async prepareNpm(
    actor: string | null,
    input: { package: string; version?: string },
    opts: ActorOpts = {},
  ): Promise<{ stagingId: string; review: PluginReview }> {
    const got = await this.installs.fetchNpm(input);
    const provenance = await this.installs.fetchProvenance({
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
        detail: { registry: new URL(this.config.get().packages.npmRegistry).origin },
      },
      { ...opts, expect: { packageName: input.package }, provenance: { provenance } },
    );
    return { stagingId: r.stagingId, review: r.review };
  }

  /**
   * A staged import's review, as prepare returned it, with a marketplace import's permission
   * mismatch when there is one (the import page loads `?staging=<id>` with it). Unknown, expired or
   * already confirmed -> 404 `plugin.staging_not_found`. Each sees only its own staging (P3-8):
   * the super admin's routes the platform's (no `owner`), an org's routes that org's.
   */
  async staged(
    stagingId: string,
    owner?: ImportOwner,
  ): Promise<{
    stagingId: string;
    review: PluginReview;
    permissionsMismatch?: PermissionsMismatch;
  }> {
    if (!UUID_RE.test(stagingId)) throw notFound();
    const row = await this.db
      .selectFrom("plugin_import_staging")
      .select(["id", "review", "manifest"])
      .where("id", "=", stagingId)
      .where("expires_at", ">", sql<Date>`now()`)
      .where(ownStaging(owner))
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
   * What an org's staged upload targets (P3-12, pre-flight F3): its item, version and review hash,
   * whether the item exists (a new version of the org's own plugin) or the version is imported
   * already (F4), and the target as the platform updater reads it: the staged manifest and files,
   * or the imported version's for a retry. Another org's staging -> 404 `plugin.staging_not_found`.
   */
  async stagedTarget(stagingId: string, owner: ImportOwner): Promise<StagedTarget> {
    if (!UUID_RE.test(stagingId)) throw notFound();
    const row = await this.db
      .selectFrom("plugin_import_staging")
      .select(["review", "manifest", "object_prefix"])
      .where("id", "=", stagingId)
      .where("expires_at", ">", sql<Date>`now()`)
      .where(ownStaging(owner))
      .executeTakeFirst();
    if (!row) throw notFound();
    const review = row.review as PluginReview;
    const staged = row.manifest as StagedPlugin;
    const item = await this.db
      .selectFrom("catalog_items")
      .select(["id", "awaiting_confirmation"])
      .where("id", "=", staged.itemId)
      .where("deleted_at", "is", null)
      .where("owner_org_id", "=", owner.orgId)
      .executeTakeFirst();
    const imported =
      staged.retry === true
        ? await this.db
            .selectFrom("catalog_item_versions")
            .select(["version", "manifest", "object_prefix", "files", "extension_sha256"])
            .where("item_id", "=", staged.itemId)
            .where("version", "=", staged.version)
            .executeTakeFirst()
        : undefined;
    return {
      itemId: staged.itemId,
      version: staged.version,
      reviewHash: review.reviewHash,
      extension: review.extension !== undefined,
      existing: item !== undefined,
      awaiting: item?.awaiting_confirmation === true,
      retry: staged.retry === true,
      target:
        imported !== undefined
          ? {
              version: imported.version,
              manifest: imported.manifest as PluginManifest,
              object_prefix: imported.object_prefix,
              files: imported.files as StagedTarget["target"]["files"],
              extension_sha256: imported.extension_sha256,
            }
          : {
              version: staged.version,
              manifest: staged.manifest,
              object_prefix: row.object_prefix,
              files: staged.files,
              extension_sha256: review.extension?.sha256 ?? null,
            },
    };
  }

  /** The catalog item's view (as a confirm returns it). */
  async view(itemId: string): Promise<CatalogItemView> {
    return this.itemView(itemId);
  }

  /**
   * Confirms a staged import (see the file header). Returns the committed catalog item and the
   * extension's deploy result (a failed deploy is returned, not thrown). `scope` (default
   * `optional`) and `orgs` (only with `named`; each an existing org, else `validation_failed`) are
   * written when this confirm creates the item; a new version of an existing item keeps its scope.
   * The caller enqueues the scope sync of the item after this returns.
   *
   * An org upload (`opts.owner`, spec §14): only that org's staging; the actor re-checked as its
   * admin; `scope` / `orgs` are not taken: a new item is owned by the org, scope `named: [owner]`,
   * not shown to other orgs, `shareable` as given (default false). Custom deny, the name owner and
   * the dependencies are checked again under the item name's lock. A package with an extension
   * is stored and its extension name claimed, nothing approved or installed: the version waits
   * for the super admin (`pending`, ruling P3-10; see {@link commit}).
   */
  async confirm(
    actor: string | null,
    stagingId: string,
    input: {
      reviewHash: string;
      /**
       * Enable the extension after installing it (default true). false keeps the install record's
       * desired state (a new install stays disabled), for the bootstrap step's upgrades of a
       * plugin a super admin may have disabled.
       */
      enable?: boolean;
      /** The new item's scope (default `optional`). */
      scope?: PluginScope;
      /** The orgs of a `named` scope. */
      orgs?: string[];
      /**
       * The skills (by name, each in the review) suggested as pinned when an agent selects them
       * (spec §9.1); replaces the plugin's `pinned` flags in the stored manifest. Omitted keeps
       * them. An admin decision like the scope, so not part of `reviewHash`.
       */
      pinnedSuggestions?: string[];
      /** An org upload's new item: shared with other orgs by its owner (default false, P3-16). */
      shareable?: boolean;
    },
    opts: ActorOpts & { owner?: ImportOwner } = {},
  ): Promise<PluginConfirmResult> {
    if (!UUID_RE.test(stagingId)) throw notFound();
    const owner = opts.owner;
    if (owner !== undefined && (input.scope !== undefined || input.orgs !== undefined)) {
      throw new Error("an org upload's scope is its owner's");
    }
    // A staging prepared by approving an org's `import` request defaults to that org (spec §5.1
    // rule 3); the admin may still choose any scope
    const linked =
      input.scope === undefined && owner === undefined
        ? await importRequestOf(this.db, stagingId)
        : undefined;
    const scope =
      owner !== undefined
        ? "named"
        : (input.scope ?? (linked !== undefined ? "named" : "optional"));
    const orgs =
      owner !== undefined
        ? [owner.orgId]
        : (input.orgs ?? (linked !== undefined ? [linked.orgId] : undefined));
    if (input.orgs !== undefined && scope !== "named") {
      throw new ApiError("validation_failed", "orgs: only allowed with scope named", [
        { path: "orgs", message: "only allowed with scope named" },
      ]);
    }
    if (scope === "named" && (orgs ?? []).length === 0) {
      throw new ApiError("validation_failed", "orgs: scope named needs at least one organization", [
        { path: "orgs", message: "scope named needs at least one organization" },
      ]);
    }
    const row = await this.db
      .selectFrom("plugin_import_staging")
      .selectAll()
      .where("id", "=", stagingId)
      .where("expires_at", ">", sql<Date>`now()`)
      .where(ownStaging(owner))
      .executeTakeFirst();
    if (!row) throw notFound();
    const review = row.review as PluginReview;
    const staged = row.manifest as StagedPlugin;
    const src = row.source as PluginImportSource;
    if (input.reviewHash !== review.reviewHash) throw reviewStale(review);
    const manifest = withPinned(staged.manifest, review, input.pinnedSuggestions);
    const reviewed = review.extension;
    // Read the stored package outside the transaction (unless it was already installed as is, or
    // an org upload, which approves nothing)
    const stored =
      reviewed && reviewed.action !== "keep" && owner === undefined
        ? await this.readStored(reviewed.sha256)
        : undefined;

    const committed = await this.commit(
      actor,
      { stagingId, review, staged, src, manifest, objectPrefix: row.object_prefix },
      {
        scope,
        orgs: [...new Set(orgs ?? [])].sort(),
        ...(owner !== undefined && { owner, shareable: input.shareable ?? false }),
      },
      stored,
      opts,
    );

    const { now } = committed;
    if (committed.pending) {
      // Waits for the super admin (P3-10): no platform components, nothing deployed
      return {
        item: await this.itemView(committed.itemId),
        created: committed.created,
        deploy: null,
        pending: true,
        firstVersion: false,
      };
    }
    // A new item's skills, agent templates and connector templates become platform components
    // (plugin scope phase 2); a new version of an existing item leaves them to the platform
    // update. After the commit: it copies files in object storage
    if (committed.firstVersion) await this.syncPlatform(committed.itemId, staged.version);
    const deploy =
      now && now.action !== "keep"
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
    return {
      item: await this.itemView(committed.itemId),
      created: committed.created,
      deploy,
      pending: false,
      firstVersion: committed.firstVersion,
    };
  }

  /**
   * Writes the platform components of an item's first usable version after a commit made
   * elsewhere (the super admin's confirmation of an org upload, `CatalogScopeService`); a failure
   * is logged and retried by the migration job (see {@link syncPlatform}).
   */
  async writePlatformComponents(itemId: string, version: string): Promise<void> {
    await this.syncPlatform(itemId, version);
  }

  /**
   * The confirm's transaction: the staging row consumed, the extension's action recomputed under
   * its install lock (stale -> `plugin.review_stale`), its snapshot approved, and the catalog
   * version written under the item name's lock.
   *
   * An org upload with an extension (ruling P3-10) approves nothing: under the install lock it
   * claims the extension name for its package (another package's -> 409
   * `extension.name_conflict` naming its owner, before anything is written), and the version
   * written becomes the item's pending one (`pending_version` / `_by` / `_at`; a first version
   * also `awaiting_confirmation`). A later upload replaces the pending version (P3-11). An org
   * upload without an extension for an item whose first version still waits (plan Task 6) replaces
   * that upload and applies at once: the item stops waiting and the claim is released (nothing
   * was installed under it).
   */
  @Transactional()
  private async commit(
    actor: string | null,
    c: {
      stagingId: string;
      review: PluginReview;
      staged: StagedPlugin;
      src: PluginImportSource;
      manifest: StagedPlugin["manifest"];
      objectPrefix: string | null;
    },
    scope: { scope: PluginScope; orgs: string[]; owner?: ImportOwner; shareable?: boolean },
    stored: ExtensionPackage | undefined,
    opts: ActorOpts,
  ): Promise<{
    itemId: string;
    /** This confirm created the catalog item (a first import of the name). */
    created: boolean;
    /** The item's first usable version (see {@link PluginConfirmResult.firstVersion}). */
    firstVersion: boolean;
    /** An org upload's version waits for the super admin. */
    pending: boolean;
    now: PluginReviewExtension | undefined;
    previous: PreviousSnapshot | null | undefined;
  }> {
    const { stagingId, review, staged, src, manifest } = c;
    const reviewed = review.extension;
    const stale = () => reviewStale(review);
    const { owner } = scope;
    await this.authorizeActor(actor, owner);
    const t = this.db;
    const used = await t
      .deleteFrom("plugin_import_staging")
      .where("id", "=", stagingId)
      .where("expires_at", ">", sql<Date>`now()`)
      .where(ownStaging(owner))
      .returning("id")
      .executeTakeFirst();
    if (!used) throw notFound();
    if (owner !== undefined) {
      await assertCustomContent(t, {
        skills: review.skills,
        agentTemplates: review.agentTemplates ?? [],
        templates: review.connectorTemplates,
      });
    }
    await assertOrgsExist(t, scope.orgs);
    // Checked again before this upload claims anything (ruling P3-51)
    if (owner !== undefined) await assertPackageFree(t, staged.packageName, owner.orgId);
    let now: PluginReviewExtension | undefined;
    let previous: PreviousSnapshot | null | undefined;
    if (reviewed) {
      // The same per-name advisory lock as ExtensionAdminOps.install; under it the action is
      // recomputed from the current deployment state (installed / upgraded / swapped since the
      // review -> stale)
      await this.installLock.lock(reviewed.name);
      now = {
        ...reviewed,
        ...actionOf(
          await this.extensionState(reviewed.name, staged.packageName as string),
          reviewed.sha256,
          reviewed.version,
        ),
      };
      if (pluginReviewHash({ ...review, extension: now }, staged.files) !== review.reviewHash) {
        throw stale();
      }
      if (owner !== undefined) {
        // An org upload only claims the name (P3-10): the super admin approves and installs it
        await t
          .insertInto("extension_name_owners")
          .values({ name: reviewed.name, package_name: staged.packageName as string })
          .onConflict((oc) => oc.column("name").doNothing())
          .execute();
        await assertPluginNameOwner(t, reviewed.name, staged.packageName);
      }
      // A foreseeable deploy failure (a downgrade to a version with unrun migrations) is refused
      // before anything is written
      if (now.action === "upgrade" && stored) {
        await assertDowngradable(t, now, stored.migrationSql);
      }
      if (owner === undefined && (now.action === "install" || now.action === "upgrade")) {
        previous = await this.approve(actor, review, staged, now, stored as ExtensionPackage, opts);
      }
    }
    const m = manifest;
    await this.itemLock.lock(m.name);
    // Under the name's lock: the first confirm of a name wins, a later one of another owner is
    // refused naming it, before anything of it is written (P3-14)
    await assertNameFree(t, m.name, owner?.orgId ?? null);
    if (owner !== undefined) {
      await assertNameNotReserved(t, m.name);
      await this.resolveDependencies(m, owner);
    }
    // The scope the audit records: the review's for a new item, the item's own for a new version
    // of a live item (which keeps its scope)
    const existing = await t
      .selectFrom("catalog_items")
      .select(["id", "scope", "awaiting_confirmation", "package_name"])
      .where("name", "=", m.name)
      .where("deleted_at", "is", null)
      .forUpdate()
      .executeTakeFirst();
    const actual =
      existing === undefined
        ? scope
        : {
            scope: existing.scope,
            orgs: (
              await t
                .selectFrom("catalog_item_scope_orgs")
                .select("org_id")
                .where("item_id", "=", existing.id)
                .orderBy("org_id")
                .execute()
            ).map((r) => r.org_id),
          };
    if (staged.retry === true) {
      // An org's own version imported already (pre-flight F4): nothing to write, the caller
      // retries its update; it must still be there as reviewed
      const v =
        existing === undefined
          ? undefined
          : await t
              .selectFrom("catalog_item_versions")
              .select("version")
              .where("item_id", "=", existing.id)
              .where("version", "=", staged.version)
              .where("content_digest", "=", staged.contentDigest)
              .executeTakeFirst();
      if (existing === undefined || existing.id !== staged.itemId || v === undefined) throw stale();
      return {
        itemId: existing.id,
        created: false,
        firstVersion: false,
        pending: false,
        now,
        previous,
      };
    }
    const { id: itemId, created } = await writeCatalogVersion(t, {
      // an org's version becomes its latest only when applied or confirmed (P3-34)
      ...(owner !== undefined && { keepLatest: true }),
      actor,
      ...(opts.actorTokenId !== undefined && { actorTokenId: opts.actorTokenId }),
      name: m.name,
      packageName: staged.packageName,
      version: staged.version,
      contentDigest: staged.contentDigest,
      manifest: m,
      listing: {
        publisher: m.publisher,
        description: pluginDescription(m.description).en,
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
      objectPrefix: c.objectPrefix,
      extensionSha256: reviewed?.sha256 ?? null,
      files: staged.files,
      size: staged.size,
      sourceFormat: staged.sourceFormat ?? "capybara",
      translation: staged.translation ?? null,
      licenseText: staged.licenseText ?? null,
      licenseTruncated: staged.licenseTruncated === true,
      auditDetail: {
        stagingId,
        scope: actual.scope,
        ...(actual.scope === "named" && { orgs: actual.orgs }),
        suggestedPinned: pinnedNames(manifest, review),
        ...(now && { extension: { name: now.name, version: now.version, action: now.action } }),
      },
    });
    // A new item gets the scope chosen in the review; a new version keeps the item's scope, its
    // org list and its scope version (prepare reuses the live item's id, so the id cannot tell)
    if (created) {
      await t
        .updateTable("catalog_items")
        .set({
          scope: scope.scope,
          // an org upload: the org owns it, nobody else sees it until shared and shown (P3-16)
          ...(owner !== undefined && {
            owner_org_id: owner.orgId,
            shareable: scope.shareable === true,
            shown_to_others: false,
          }),
        })
        .where("id", "=", itemId)
        .execute();
      if (scope.scope === "named" && scope.orgs.length > 0) {
        await t
          .insertInto("catalog_item_scope_orgs")
          .values(scope.orgs.map((org_id) => ({ item_id: itemId, org_id })))
          .onConflict((oc) => oc.doNothing())
          .execute();
      }
    }
    // The org requests this staging answers resolve with the confirm; on an item that existed
    // already (imported meanwhile) a `named` scope gains their orgs. An org-owned item held back by
    // the share gate fails closed before any request is marked (ruling P3-26; P3-14 refuses a
    // super admin import of an org-owned name, so this should not be reached)
    const item = created
      ? undefined
      : await t
          .selectFrom("catalog_items")
          .select(["id", "name", "scope", "builtin", "owner_org_id", "shareable"])
          .where("id", "=", itemId)
          .forUpdate()
          .executeTakeFirstOrThrow();
    if (item !== undefined && !shareGate(item) && (await hasImportRequests(t, stagingId))) {
      assertShareable(item);
    }
    const requestOrgs = await resolveImportRequests(t, stagingId, itemId, actor, opts);
    if (item !== undefined) {
      for (const org of requestOrgs) await addScopeOrg(t, actor, item, org, opts);
    }
    const pending = owner !== undefined && reviewed !== undefined;
    // An org's first version without an extension is installed at once: applied (P3-52)
    if (owner !== undefined && created && !pending)
      await markVersionApplied(t, itemId, staged.version);
    if (pending) {
      // Waits for the super admin; a later upload replaces the pending version (P3-10, P3-11)
      await t
        .updateTable("catalog_items")
        .set({
          ...(created && { awaiting_confirmation: true }),
          pending_version: staged.version,
          pending_by: actor,
          pending_at: sql<Date>`now()` as unknown as Date,
        })
        .where("id", "=", itemId)
        .execute();
    }
    // A first version still waiting replaced by one without an extension: applied at once
    const replacedAwaiting =
      owner !== undefined && !pending && existing?.awaiting_confirmation === true;
    if (replacedAwaiting) {
      await t
        .updateTable("catalog_items")
        .set({
          awaiting_confirmation: false,
          pending_version: null,
          pending_by: null,
          pending_at: null,
          latest_version: staged.version,
        })
        .where("id", "=", itemId)
        .execute();
      await markVersionApplied(t, itemId, staged.version);
      await releaseExtensionClaim(t, m.name, existing.package_name);
    }
    return {
      itemId,
      created,
      firstVersion: (created && !pending) || replacedAwaiting,
      pending,
      now,
      previous,
    };
  }

  /**
   * The platform components of a new item. The item is committed already, so a failure is logged
   * and not thrown (like a failed deploy, the import itself succeeded); a run of the platform
   * components migration job (which writes what is missing) is enqueued on `cap-kernel-maintenance`
   * after {@link PLATFORM_SYNC_RETRY_MS}, one per item (deterministic job id). If that run fails
   * too, its `itemsFailed` shows in the super admin's inbox; the daily run and every worker start
   * try again.
   */
  private async syncPlatform(itemId: string, version: string): Promise<void> {
    try {
      await this.platform.syncFromVersion(itemId, version, { initial: true });
    } catch (err) {
      // Removed meanwhile (an org deletion racing a confirmation, P3-20): nothing to write
      const live = await this.db
        .selectFrom("catalog_items")
        .select("id")
        .where("id", "=", itemId)
        .where("deleted_at", "is", null)
        .executeTakeFirst();
      if (live === undefined) {
        this.log.info("catalog item removed before its platform components were written", {
          itemId,
          version,
        });
        return;
      }
      this.log.error("writing the platform components of a new catalog item failed", {
        itemId,
        version,
        err,
      });
      try {
        await this.maintenance.add(
          PLATFORM_MIGRATION_JOB,
          {},
          {
            jobId: `${PLATFORM_MIGRATION_JOB}-retry-${itemId}`,
            delay: PLATFORM_SYNC_RETRY_MS,
            attempts: 1,
            removeOnComplete: true,
            removeOnFail: { age: 86_400 },
          },
        );
      } catch (e) {
        this.log.warn("cannot enqueue the platform components migration", { itemId, err: e });
      }
    }
  }

  /**
   * Writes the extension's permission snapshot for the version being imported (source web; cli
   * without an actor; bootstrap for the bootstrap step), after
   * registering the name owner like ExtensionAdminOps.install (Ruling P3). Returns the snapshot it
   * overwrote (null when there was none).
   */
  @Transactional({ propagation: "mandatory" })
  private async approve(
    actor: string | null,
    review: PluginReview,
    staged: StagedPlugin,
    p: PluginReviewExtension,
    pkg: ExtensionPackage,
    opts: ActorOpts,
  ): Promise<PreviousSnapshot | null> {
    const set = permissionSetOfPackage(pkg);
    await this.approveLock.lock(p.name);
    const t = this.db;
    const snapRow = await t
      .selectFrom("extension_permission_snapshots")
      .selectAll()
      .where("plugin", "=", p.name)
      .forUpdate()
      .executeTakeFirst();
    await t
      .insertInto("extension_name_owners")
      .values({ name: p.name, package_name: staged.packageName as string })
      .onConflict((oc) => oc.column("name").doNothing())
      .execute();
    await assertPluginNameOwner(t, p.name, staged.packageName);
    const { added, removed } = diffPermissions(
      snapRow?.permissions as PermissionSet | undefined,
      set,
    );
    await writeSnapshot(t, p.name, p.version, set, {
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
   * change keeps the desired state) then `enable`, unless another enabled extension provides one of
   * its single-provider extension points: then it stays disabled (result `installed` with code
   * `extension.single_provider_enabled`). Nothing is thrown; the result says what happened.
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
    let installed: InstallView;
    try {
      installed = await this.ops.install(p.name, p.sha256, actor, opts.actorTokenId, {
        catalogItemId: itemId,
      });
    } catch (e) {
      this.log.warn("installing a plugin's extension on the deployment failed", {
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
          this.log.error("cannot restore the permission snapshot of a plugin's extension", {
            plugin: p.name,
            err,
          });
        }
      }
      return result;
    }
    // An upgrade of an enabled extension that newly provides a held single-provider point: left
    // disabled by the install, and why
    if (installed.leftDisabled !== undefined) {
      return { ...base, result: "installed", ...installed.leftDisabled };
    }
    if (!enable) return { ...base, result: "installed" };
    try {
      const r = await this.ops.enableUnlessOccupied(p.name, actor, opts.actorTokenId);
      if (r.enabled) return { ...base, result: "enabled" };
      // A single-provider point another enabled extension provides: installed disabled, and why
      return { ...base, result: "installed", ...r.note };
    } catch (e) {
      this.log.warn("enabling a plugin's extension failed", { plugin: p.name, err: e });
      return { ...base, result: "failed", ...failure(e) };
    }
  }

  /**
   * Restores the snapshot overwritten at confirm (deletes it when there was none before), audits
   * `extension.permissions_restored`. Compare-and-write (row locked): restores only while the
   * snapshot is still the one written at confirm (this version, approved by this actor); if someone
   * approved or changed it meanwhile it is left alone and false is returned.
   */
  @Transactional()
  private async restoreSnapshot(
    actor: string | null,
    review: PluginReview,
    p: PluginReviewExtension,
    prev: PreviousSnapshot | null,
    opts: ActorOpts,
  ): Promise<boolean> {
    const t = this.db;
    await this.approveLock.lock(p.name);
    const current = await t
      .selectFrom("extension_permission_snapshots")
      .select(["version", "approved_by"])
      .where("plugin", "=", p.name)
      .forUpdate()
      .executeTakeFirst();
    if (current?.version !== p.version || current.approved_by !== actor) return false;
    if (prev) {
      await t
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
      await t.deleteFrom("extension_permission_snapshots").where("plugin", "=", p.name).execute();
    }
    await audit(t, {
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
  }

  /**
   * Deletes expired staging rows and their object prefixes (maintenance job `app-staging-cleanup`),
   * then the unused display files ({@link sweepDisplayFiles}). Row by row: objects first, then the
   * row (a failed object delete keeps the row for the next round); concurrent replicas skip each
   * other's rows (`SKIP LOCKED`). Returns the rows deleted.
   */
  async cleanupExpired(): Promise<number> {
    const total = await this.cleanupStagingRows();
    // display files no version or staging lists (an abandoned import's), older than a staging
    try {
      await sweepDisplayFiles(this.db, PLUGIN_STAGING_TTL_MS);
    } catch (err) {
      this.log.warn("cannot sweep unused catalog display files", { err });
    }
    return total;
  }

  /** The expired staging rows, batch by batch; returns the rows deleted. */
  private async cleanupStagingRows(): Promise<number> {
    let total = 0;
    for (;;) {
      const batch = await this.db
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
          const done = await this.cleanupOne(r);
          if (done) {
            total++;
            progressed++;
          }
        } catch (err) {
          this.log.warn("cannot clean up an expired plugin import", { stagingId: r.id, err });
        }
      }
      if (progressed === 0 || batch.length < CLEANUP_BATCH) return total;
    }
  }

  /**
   * One expired staging row (row lock, `SKIP LOCKED`): its objects, then the row; false when another
   * replica has it or it is gone.
   */
  @Transactional()
  private async cleanupOne(r: { id: string; object_prefix: string | null }): Promise<boolean> {
    const t = this.db;
    const locked = await t
      .selectFrom("plugin_import_staging")
      .select(["id", "org_id", "review", "manifest"])
      .where("id", "=", r.id)
      .where("expires_at", "<=", sql<Date>`now()`)
      .forUpdate()
      .skipLocked()
      .executeTakeFirst();
    if (!locked) return false;
    if (r.object_prefix) await this.files.deployment().deletePrefix(r.object_prefix);
    await t.deleteFrom("plugin_import_staging").where("id", "=", r.id).execute();
    await this.dropOrgPackage(locked);
    return true;
  }

  /**
   * An expired org staging's extension package (an org upload stores it at prepare, P3-10): removed
   * with the staging unless something else uses it — an install (running or migrated), a catalog
   * version, another staging — or it was stored by anyone else (the package row's source must be
   * this staging's own `catalog` ref). A platform staging keeps its package, as before. Its object
   * is deleted after the commit.
   */
  @Transactional({ propagation: "mandatory" })
  private async dropOrgPackage(row: {
    org_id: string | null;
    review: unknown;
    manifest: unknown;
  }): Promise<void> {
    const sha = (row.review as PluginReview).extension?.sha256;
    if (row.org_id === null || sha === undefined) return;
    const staged = row.manifest as StagedPlugin;
    const t = this.db;
    const pkg = await t
      .selectFrom("extension_packages")
      .select("blob_store")
      .where("sha256", "=", sha)
      .where("source", "=", "catalog")
      .where("source_ref", "=", `${staged.itemId}@${staged.version}`)
      .forUpdate()
      .executeTakeFirst();
    if (!pkg) return;
    const used =
      (await t
        .selectFrom("extension_installs")
        .select("name")
        .where((eb) => eb.or([eb("sha256", "=", sha), eb("migrated_sha", "=", sha)]))
        .executeTakeFirst()) ??
      (await t
        .selectFrom("catalog_item_versions")
        .select("version")
        .where("extension_sha256", "=", sha)
        .executeTakeFirst()) ??
      (await t
        .selectFrom("plugin_import_staging")
        .select("id")
        .where(sql<boolean>`review->'extension'->>'sha256' = ${sha}`)
        .executeTakeFirst());
    if (used !== undefined) return;
    // extension_blobs (a PG-stored package) goes with the row (ON DELETE CASCADE)
    await t.deleteFrom("extension_packages").where("sha256", "=", sha).execute();
    // The object only once the row is gone for good: a failure leaves an unreferenced object
    // (harmless; a later upload of the same bytes rewrites it), never a row without its bytes
    if (pkg.blob_store === "object") {
      afterCommit(async () => {
        try {
          await this.files.deployment().delete(blobKey(sha));
        } catch (err) {
          this.log.warn("cannot delete an expired org upload's extension package object", {
            sha256: sha,
            err,
          });
        }
      });
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
    const declared = this.registry.declared().get(name);
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
    /** The paths of `files` kept in PG (`catalog_files`): icons and setup guide files. */
    displayPaths: Set<string>;
    /**
     * The paths of `files` kept under the version's object prefix: skill files, connector and agent
     * templates, theme files and their assets (a display path may be one too: then it is kept in
     * both places).
     */
    objectPaths: Set<string>;
    templates: PluginReviewTemplate[];
    skills: PluginReview["skills"];
    agentTemplates: PluginReviewAgentTemplate[];
    themes: PluginReviewTheme[];
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
    const objectPaths = new Set<string>();
    const keepObject = (path: string) => {
      keep(path);
      if (stored.has(path)) objectPaths.add(path);
    };
    // The plugin icon and the setup guide templates (rendered by PluginGuides): display files
    const displayPaths = displayFilePaths(
      m,
      pkg.connectorTemplates.flatMap((c) => (c.file.icon === undefined ? [] : [c.file.icon])),
    );
    for (const path of displayPaths) keep(path);

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
        for (const f of s.files) keepObject(`${s.dir}/${f}`);
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
      const loaded = findConnectorIn(this.registry, t.plugin, t.connector);
      if (loaded) {
        problems.push(...templateProblems(loaded, t, at));
        const v = this.registry.manifests().find((x) => x.name === t.plugin)?.version;
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
        !this.connectorsLoaded ||
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
      keepObject(c.path);
      templatePaths.set(c.id, c.path);
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
      keepObject(a.path);
      const { name, description, instructions, model, ...rest } = a.template;
      return { name, path: a.path, description, instructions, model: model ?? "inherit", ...rest };
    });
    // Themes: the file as written, the assets as sanitized by the reader (never the uploaded
    // originals: a shared path, e.g. the plugin icon, is stored sanitized too)
    const themes: PluginReviewTheme[] = pkg.themes.map((t) => {
      keepObject(t.path);
      for (const [path, data] of t.assets) {
        stored.set(path, fileOf(path, data));
        objectPaths.add(path);
      }
      const logo = t.theme.logo;
      return {
        id: t.id,
        name: t.theme.name,
        schemes: (["dark", "light"] as const).filter((k) => t.theme.schemes[k] !== undefined),
        fonts: t.theme.fonts?.length ?? 0,
        logo: logo !== undefined && Object.keys(logo).length > 0,
      };
    });
    if (problems.length > 0) throw invalid(problems);
    return {
      files: [...stored.values()],
      displayPaths,
      objectPaths,
      templates,
      skills,
      agentTemplates,
      themes,
      notLoaded,
      templatePaths,
    };
  }

  /**
   * The highest imported, non-deleted catalog version satisfying each dependency's range (null when
   * none does). An org upload (`owner`, P3-13) resolves only against items the org can use
   * ({@link usableBy}: confirmed, not disabled, offered to it), and any dependency left unresolved
   * -> 409 `plugin.dependency_unavailable` (details `[{ dependencies }]`, their names): an org
   * upload never brings in anything the org could not install itself.
   */
  private async resolveDependencies(
    m: PluginManifest,
    owner?: ImportOwner,
  ): Promise<PluginReview["dependencies"]> {
    const deps = m.dependencies ?? [];
    if (deps.length === 0) return [];
    const names = deps.map((d) => d.name);
    const versions = this.db
      .selectFrom("catalog_items as i")
      .innerJoin("catalog_item_versions as v", "v.item_id", "i.id")
      .where("i.deleted_at", "is", null)
      .where("i.name", "in", names);
    const rows: { name: string; version: string; imported_at: Date }[] =
      owner === undefined
        ? await versions.select(["i.name", "v.version", "v.imported_at"]).execute()
        : (
            await versions
              // the org's own row of a `named` list (usableBy reads whether it is listed)
              .leftJoin("catalog_item_scope_orgs as so", (j) =>
                j.onRef("so.item_id", "=", "i.id").on("so.org_id", "=", owner.orgId),
              )
              .select([
                "i.name",
                "v.version",
                "v.imported_at",
                "i.scope",
                "i.builtin",
                "i.disabled",
                "i.deleted_at",
                "i.awaiting_confirmation",
                "i.owner_org_id",
                "i.shareable",
                "so.org_id as listed",
              ])
              .execute()
          ).filter((r) => usableBy(r, owner.orgId, r.listed !== null));
    const resolved = deps.map((d) => ({
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
    const missing = resolved.filter((d) => d.resolved === null).map((d) => d.name);
    if (owner !== undefined && missing.length > 0) {
      throw new ApiError(
        "plugin.dependency_unavailable",
        `Dependencies not available to this organization: ${missing.join(", ")}`,
        [{ dependencies: missing }],
      );
    }
    return resolved;
  }

  /**
   * The extension's state on the deployment; installed from another npm package ->
   * `extension.name_conflict`.
   */
  private async extensionState(name: string, packageName: string): Promise<ExtensionState> {
    const r = await this.db
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
        [{ owner: await packageOwner(this.db, r.package_name, name) }],
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
    const snap = await this.db
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
      ...actionOf(state, pkg.sha256, pkg.section.version),
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
    const bytes = await this.blobs.get(sha256);
    return readingPackage(() =>
      readExtensionPackage(bytes, {
        maxBytes: this.config.get().packages.maxBytes,
        hostSdkVersion: SDK_VERSION,
      }),
    );
  }

  private async itemView(itemId: string): Promise<CatalogItemView> {
    const item = await this.db
      .selectFrom("catalog_items")
      .selectAll()
      .where("id", "=", itemId)
      .executeTakeFirstOrThrow();
    const versions = await this.db
      .selectFrom("catalog_item_versions")
      .select(["version", "source", "imported_at", "extension_sha256", "manifest", "source_format"])
      .where("item_id", "=", itemId)
      .execute();
    const facts = await itemScopeFacts(
      this.db,
      [item],
      await itemConfirmations(this.admin, [item], new Map([[item.id, versions]])),
    );
    return itemView(item, versions, 0, undefined, facts.get(item.id));
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
  const { agents: _, themes: __, ...manifest } = pkg.manifest;
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
    ...(pkg.themes.length > 0 && { themes: pkg.themes.map((t) => ({ path: `./${t.path}` })) }),
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
  version: string,
): Pick<
  PluginReviewExtension,
  "action" | "deployed" | "currentVersion" | "currentSha256" | "olderThanDeployed"
> {
  if (s.kind === "installed") {
    // A version below the deployed one is recorded in the catalog only: an import never
    // downgrades the deployment (ruling H)
    const older =
      s.sha256 !== sha256 &&
      semver.valid(version) !== null &&
      semver.valid(s.version) !== null &&
      semver.lt(version, s.version);
    return {
      action: s.sha256 === sha256 || older ? "keep" : "upgrade",
      deployed: true,
      currentVersion: s.version,
      currentSha256: s.sha256,
      ...(older && { olderThanDeployed: true as const }),
    };
  }
  return { action: "install", deployed: false, currentVersion: null, currentSha256: null };
}

/**
 * The review digest (first 32 hex of a sha256): name, version and content digest, the extension (sha256, action,
 * current version / package, its own review digest), every template field, each skill's name / path
 * / file count, the dependency resolution, the sha256 of every stored file, the format, the
 * translation report's items, the sha256 of the license text and the two review flags
 * (`claudeManifestIgnored`, `licenseTruncated`), the agent templates when there are any and the
 * themes when there are any.
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
    | "themes"
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
  // canonicalJson, not JSON.stringify: the review is stored as jsonb, which reorders object keys,
  // so a template's auth / endpoint object would hash differently at confirm (plugin.review_stale
  // on every import of a plugin whose connector template has a non-trivial auth block).
  const canonical = canonicalJson([
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
    // themes, only when there are any, tagged (never read as agent templates)
    ...((r.themes ?? []).length > 0
      ? [{ themes: (r.themes ?? []).map((t) => [t.id, canonicalJson(t)]) }]
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
  db: KernelSchemaDb,
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

/**
 * The staging rows a route may see (P3-8): the platform's (`org_id` null) without an owner, else
 * the owner org's.
 */
function ownStaging(owner: ImportOwner | undefined) {
  return (eb: ExpressionBuilder<KernelDatabase, "plugin_import_staging">) =>
    owner === undefined ? eb("org_id", "is", null) : eb("org_id", "=", owner.orgId);
}

/**
 * An org upload's custom deny, by content (ruling P3-15'): skills or agent templates ->
 * `customSkills`, connector templates -> `customConnectors`; each `deny` -> 403
 * `catalog.custom_disabled`. A package carrying neither passes; themes are covered by neither
 * switch (themes spec §6), so a themes-only upload passes.
 */
async function assertCustomContent(
  db: KernelSchemaDb,
  content: {
    skills: readonly unknown[];
    agentTemplates: readonly unknown[];
    templates: readonly unknown[];
  },
): Promise<void> {
  if (content.skills.length > 0 || content.agentTemplates.length > 0) {
    await assertCustomAllowed(db, "customSkills");
  }
  if (content.templates.length > 0) await assertCustomAllowed(db, "customConnectors");
}
