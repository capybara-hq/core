import type { AdminExtension, PackageWarning } from "./admin-extensions";
import { ApiClientError, apiFetch, CSRF_HEADER, ensureSession, toError } from "./api";
import type { PermissionGroup, PermissionItem } from "./extensions";

/**
 * The enterprise catalog (kernel `catalog/*.controller.ts`). Every catalog item is a plugin: an
 * optional extension, skills, connector templates and dependencies on other plugins.
 * - deployment level (enterprise admins): `/api/v1/admin/catalog/*` items, the plugin import
 *   (prepare from a file or npm -> one review -> confirm), policy, installing an item's extension on
 *   the deployment, deployment-stage requests; `/api/v1/admin/marketplaces/*` marketplaces, browsing
 *   their entries, preparing an import from one;
 * - org side: `/api/v1/orgs/:orgId/catalog*` browse, detail, request, install; `plugin-installs` the
 *   installed plugins and uninstall; the inbox's `catalog_request` is decided by org admins with
 *   `catalog-requests/:id/decide`.
 * Item icons come only from kernel routes (nosniff + CSP sandbox); the web shows them only in `<img>`,
 * never inline.
 */

export const CATALOG_POLICIES = ["allow", "needs_approval", "disabled"] as const;
export type CatalogPolicy = (typeof CATALOG_POLICIES)[number];

export interface LocalizedName {
  zh: string;
  en: string;
}

/** A catalog item, admin view (kernel `CatalogItemView`). */
export interface CatalogItem {
  id: string;
  name: string;
  publisher: string;
  displayName: LocalizedName | null;
  description: string;
  policy: CatalogPolicy;
  latestVersion: string;
  versions: string[];
  installs: number;
  /** The latest version's source: file / npm / marketplace. */
  source: string;
  /** The marketplace it was imported from (`official` or an enterprise marketplace id), else null. */
  marketplaceId: string | null;
  /** The highest compatible version in its marketplace (null when not from one or it is off). */
  latestMarketplaceVersion: string | null;
  /** The marketplace has a newer compatible version than the newest imported one. */
  newerInMarketplace: boolean;
  /**
   * An entry of its marketplace now points at other content for a version already imported
   * (another commit or integrity): "content changed at the same version".
   */
  contentChanged: boolean;
  updatedAt: string;
}

/** The static manifest of a plugin's extension (SDK `StaticExtensionManifest`, the parts shown). */
export interface StaticExtensionManifest {
  name: string;
  version: string;
  sdk: string;
  provides: string[];
  requires: string[];
  optional: string[];
  permissions: {
    secrets?: boolean;
    http?: { method: string; path: string; public?: boolean }[];
    tools?: string[];
    hooks?: string[];
    policyHooks?: string[];
    models?: { purpose: string }[];
    storage?: boolean;
    network?: string[];
    ui?: { views?: string[]; embeds?: string[] };
  };
  config?: { deployment: { key: string }[]; org: { key: string }[] };
}

/** A version's normalized plugin.json (SDK `PluginManifest`, the parts the web reads). */
export interface PluginManifest {
  name: string;
  version: string;
  publisher: string;
  description: string;
  displayName?: LocalizedName;
  icon?: string;
  license?: string;
  homepage?: string;
  dependencies?: { name: string; version: string }[];
  skills?: { path: string; pinned?: boolean }[];
  connectorTemplates?: { path: string }[];
  extension?: {
    entry: string;
    manifest: StaticExtensionManifest;
    migrations?: string;
    ui?: string;
  };
}

/**
 * A git source as recorded (kernel `GitSourceDetail`): the host, repo and commit actually read, and
 * whether it follows a branch (no commit was pinned). `path` is `.` for the repo root.
 */
export interface GitSourceDetail {
  host: string;
  repo: string;
  path: string;
  ref?: string;
  commit: string;
  followsBranch: boolean;
  tree?: string;
}

/** Where a catalog version came from: a git location, an archive URL, an npm registry. */
export type SourceDetail = GitSourceDetail | { url: string } | { registry: string };

/**
 * The text holds bidirectional formatting characters (U+061C, U+200E, U+200F, U+202A-U+202E,
 * U+2066-U+2069) or control characters other than tab and line breaks: the kernel's `printable`
 * class, minus the whitespace a file body has. Such text can display in another order than the
 * model reads it ("Trojan Source").
 */
export const hasHiddenCharacters = (s: string): boolean =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this finds
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(
    s,
  );

/** Report groups, in display order (kernel `TranslationGroup`). */
export const TRANSLATION_GROUPS = [
  "imported",
  "converted",
  "needsInput",
  "ignored",
  "warnings",
] as const;
export type TranslationGroup = (typeof TRANSLATION_GROUPS)[number];

/** What a report item is about (kernel `TranslationComponent`). */
export type TranslationComponent =
  | "plugin"
  | "skill"
  | "command"
  | "agent"
  | "hook"
  | "mcpServer"
  | "field"
  | "file";

/**
 * Every translation code (kernel `TranslationCode`) with the `detail` keys its localized message
 * names (`catalog.admin.review.translation.codes.<code>`). Other detail keys of an item are shown
 * as extra lines (see {@link translationExtras}).
 */
export const TRANSLATION_CODE_PLACEHOLDERS = {
  skill_imported: [],
  mcp_template: ["template", "auth"],
  skill_root_relocated: ["to"],
  version_from_entry: ["version"],
  version_fallback: ["version"],
  publisher_from_marketplace: ["publisher"],
  dependency_mapped: ["version"],
  entry_components_merged: ["keys"],
  mcp_header_variable: ["header", "variable"],
  mcp_url_variable: ["variable"],
  dependency_not_imported: ["version"],
  skill_manual_invocation: [],
  command_manual_invocation: [],
  skill_needs_subagents: [],
  agent_needs_subagents: [],
  hooks_not_run: [],
  hooks_module: [],
  mcp_unsupported_transport: ["transport"],
  mcp_invalid: [],
  skill_invalid: [],
  not_applicable: [],
  unknown_field: [],
  other_harness: [],
  skill_ignored_restrictions: ["keys"],
  skill_claude_variables: ["variables"],
  session_start_pin_hint: [],
  mcp_auth_none: [],
  mcp_type_assumed: [],
  connector_not_loaded: ["connector"],
} as const satisfies Record<string, readonly string[]>;
export type TranslationCode = keyof typeof TRANSLATION_CODE_PLACEHOLDERS;
export const TRANSLATION_CODES = Object.keys(TRANSLATION_CODE_PLACEHOLDERS) as TranslationCode[];

/**
 * Detail keys shown as extra lines with a localized label
 * (`catalog.admin.review.translation.detail.<key>`); any other key is shown as `key: value`.
 */
export const TRANSLATION_DETAIL_KEYS = [
  "problem",
  "reason",
  "handlers",
  "default",
  "marketplace",
  "more",
] as const;

/** One item of a translation report (kernel `TranslationItem`). */
export interface TranslationItem {
  group: TranslationGroup;
  component: TranslationComponent;
  name: string;
  path?: string;
  code: TranslationCode;
  detail?: Record<string, string | number>;
}

/** The translation report of a Claude Code plugin import (kernel `TranslationReport`). */
export interface TranslationReport {
  format: "claude-code";
  manifestPath: string | null;
  /** The plugin has a SessionStart hook: the skills section opens by default. */
  sessionStart: boolean;
  items: TranslationItem[];
}

/** The placeholder values of an item's message: its detail, "" for a missing placeholder. */
export function translationValues(item: TranslationItem): Record<string, string> {
  const keys: readonly string[] = TRANSLATION_CODE_PLACEHOLDERS[item.code] ?? [];
  return Object.fromEntries(keys.map((k) => [k, String(item.detail?.[k] ?? "")]));
}

/** The detail entries of an item its message does not name, in the item's key order. */
export function translationExtras(item: TranslationItem): [string, string][] {
  const named: readonly string[] = TRANSLATION_CODE_PLACEHOLDERS[item.code] ?? [];
  return Object.entries(item.detail ?? {})
    .filter(([k]) => !named.includes(k))
    .map(([k, v]) => [k, String(v)]);
}

/** The format a catalog version was read from. */
export type PluginSourceFormat = "capybara" | "claude-code";

export interface CatalogItemVersion {
  version: string;
  source: "file" | "npm" | "marketplace" | "git";
  sourceRef: string;
  integrity: string | null;
  /** The content digest of the imported files (null for a version imported before phase A1). */
  contentDigest: string | null;
  /** Where it came from (null for an upload, or a version imported before phase A1). */
  sourceDetail: SourceDetail | null;
  manifest: PluginManifest;
  size: number;
  /** The extension's package (null without an extension). */
  extensionSha256: string | null;
  importedAt: string;
  /** Absent from a kernel before phase B (then `capybara`). */
  sourceFormat?: PluginSourceFormat;
  /** The translation report of a Claude Code plugin (null for a native one). */
  translation?: TranslationReport | null;
  /** The root LICENSE text (null when there is none or it was too long). */
  licenseText?: string | null;
}

export interface CatalogItemDetail {
  /** `packageName` is null for a git plugin without package.json. */
  item: CatalogItem & { packageName: string | null; deletedAt: string | null };
  versions: CatalogItemVersion[];
  /** The latest version has an icon (shown as `<img>` through the kernel route). */
  hasIcon: boolean;
}

/** The plugin's extension in an import review (kernel `PluginReviewExtension`). */
export interface PluginReviewExtension {
  name: string;
  version: string;
  sha256: string;
  /** install: not on the deployment; upgrade: another package is installed; keep: this one is. */
  action: "install" | "upgrade" | "keep";
  deployed: boolean;
  currentVersion: string | null;
  currentSha256: string | null;
  permissions: PermissionGroup[];
  added: string[];
  addedItems: PermissionItem[];
  removed: string[];
  warnings: PackageWarning[];
  reviewHash: string;
  sensitive: boolean;
}

/** One connector template in an import review (kernel `PluginReviewTemplate`). */
export interface PluginReviewTemplate {
  id: string;
  displayName: LocalizedName;
  description: string;
  plugin: string;
  connector: string;
  endpoint: Record<string, unknown>;
  auth: Record<string, unknown>;
  editableEndpoint: string[];
  endpointChecked: boolean;
}

/**
 * npm provenance (kernel `ProvenanceResult`, display only): what the registry's SLSA provenance says
 * the package was built from, or why it was not checked.
 */
export type Provenance =
  | { checked: true; repository: string; commit: string; workflow: string; buildType: string }
  | { checked: false; reason: string };

/** Where an import comes from (kernel `PluginImportSource`). */
export interface PluginImportSource {
  kind: "file" | "npm" | "marketplace" | "git";
  ref: string;
  integrity?: string;
  marketplaceId?: string;
  detail?: SourceDetail;
}

/** The one review of a plugin import (kernel `PluginReview`). */
export interface PluginReview {
  name: string;
  /** `claude-code`: translated from a Claude Code plugin (see `translation`). */
  format?: PluginSourceFormat;
  translation?: TranslationReport;
  /** Both manifests: `.capybara-plugin/plugin.json` was read, the Claude one ignored. */
  claudeManifestIgnored?: true;
  /** A Claude plugin's `repository`: display only, from the plugin, never verified. */
  repository?: string;
  /** The root LICENSE text. */
  licenseText?: string;
  /** The root LICENSE is too long (or not UTF-8) and is not stored. */
  licenseTruncated?: true;
  /** The version recorded (with `+git.<sha12>` / `+sha256.<12>` when the release has other content). */
  version: string;
  /** The plugin's own version when `version` got build metadata appended. */
  pluginVersion?: string;
  contentDigest: string;
  /** null for a git plugin without package.json. */
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
    /** The plugin suggests pinning the skill (changed at confirm with `pinnedSuggestions`). */
    suggestPinned?: boolean;
  }[];
  connectorTemplates: PluginReviewTemplate[];
  /** Each dependency and the highest imported version satisfying its range (null: none yet). */
  dependencies: { name: string; range: string; resolved: string | null }[];
  source: PluginImportSource;
  provenance: Provenance;
  /** A git marketplace's repository differs from the attested one (a warning). */
  provenanceWarning?: "repository_mismatch";
  sensitive: boolean;
  reviewHash: string;
}

/** The marketplace's permission summary differs from the package (a warning only). */
export type PermissionsMismatch = { missing: string[]; extra: string[] } | null;

/** A prepared (staged) import: confirm it with `confirmPluginImport` within 24 hours. */
export interface PluginPrepared {
  stagingId: string;
  review: PluginReview;
  permissionsMismatch?: PermissionsMismatch;
}

/** Deploying the plugin's extension after confirm (kernel `ExtensionDeployResult`). */
export interface PluginDeployResult {
  name: string;
  action: "install" | "upgrade";
  version: string;
  sha256: string;
  result: "enabled" | "failed";
  code?: string;
  message?: string;
  /** e.g. `snapshot_not_restored: …` when an upgrade failed and the snapshot had changed since. */
  note?: string;
}

export interface PluginConfirmResult {
  item: CatalogItem;
  deploy: PluginDeployResult | null;
}

/** `http`: a marketplace.json URL; `git`: a repository with `.capybara-plugin/marketplace.json`. */
export type MarketplaceForm = "http" | "git";

/** A marketplace (kernel `MarketplaceView`). */
export interface Marketplace {
  id: string;
  name: string;
  url: string;
  form: MarketplaceForm;
  /** The ref a git marketplace follows (null: the remote HEAD; always null for http). */
  ref: string | null;
  /** The commit of a git marketplace's last successful refresh. */
  lastCommit: string | null;
  mirrors: string[];
  builtin: boolean;
  enabled: boolean;
  disabledByConfig: boolean;
  hasToken: boolean;
  lastRefreshedAt: string | null;
  lastStatus: "ok" | "error" | "never";
  lastError: string | null;
  entryCount: number;
  /** Entries the last refresh could not store, with the reason (absent before phase B). */
  skipped?: { name: string; reason: MarketplaceSkipReason }[];
}

/** Why a marketplace refresh skipped an entry (kernel `MarketplaceSkipReason`). */
export const MARKETPLACE_SKIP_REASONS = [
  "claude_npm_unpinned",
  "claude_source_unsupported",
  "invalid_name",
  "invalid_entry",
] as const;
export type MarketplaceSkipReason = (typeof MARKETPLACE_SKIP_REASONS)[number];

/** Where a marketplace entry's package comes from (SDK `MarketplaceSource`). */
export type MarketplaceSource =
  | { path: string }
  | { git: { url: string; ref?: string; commit?: string; path?: string } }
  | { npm: { package: string; version: string; integrity: string } }
  | { archive: { url: string; integrity: string } };

/** A marketplace entry: one version of a plugin (kernel `MarketplaceEntryView`). */
export interface MarketplaceEntry {
  sourceId: string;
  sourceName: string;
  name: string;
  version: string | null;
  summary: { en: string; zh?: string };
  minKernel: string | null;
  homepage: string | null;
  permissions: { keys: string[]; sensitive: string[] } | null;
  source: MarketplaceSource;
  compatible: boolean;
  /** The kernel can import this entry (see `reason` when it cannot). */
  importable: boolean;
  /** host_not_allowed: outside `marketplaces.allowedHosts`; a path entry of an http marketplace. */
  reason?: "host_not_allowed" | "path_needs_git_marketplace";
  adopted: { itemId: string; versions: string[] } | null;
  newerAvailable: boolean;
  /**
   * A version of this release is imported, but the entry now points at other content (a moved
   * branch, a new marketplace commit, another integrity); importing again records a build version.
   */
  contentChanged: boolean;
}

/** A catalog request (kernel `CatalogRequestView`). */
export interface CatalogRequest {
  id: string;
  orgId: string;
  orgName: string;
  item: { id: string; name: string; displayName: LocalizedName | null };
  version: string | null;
  stage: "org" | "deployment";
  status: "pending" | "approved" | "rejected" | "cancelled";
  note: string;
  requestedBy: string | null;
  requestedByName: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  orgDecidedBy: string | null;
  orgDecidedAt: string | null;
  createdAt: string;
}

/** A catalog item from the org's view (kernel `OrgCatalogItem`). */
export interface OrgCatalogItem
  extends Omit<
    CatalogItem,
    "installs" | "marketplaceId" | "latestMarketplaceVersion" | "newerInMarketplace"
  > {
  installable: "yes" | "needs_approval" | "granted" | "disabled" | "not_deployed";
  /** This org's live plugin install of the item; `upgradeAvailable` the version it can move to now. */
  installed: { pluginInstallId: string; version: string; upgradeAvailable: string | null } | null;
  request: { id: string; stage: "org" | "deployment"; status: string } | null;
}

/** A connector template in an item's detail (kernel `OrgCatalogTemplate`). */
export interface OrgCatalogTemplate {
  id: string;
  displayName: LocalizedName | null;
  description: string;
  plugin: string;
  connector: string;
  endpoint: Record<string, unknown>;
  editableEndpoint: string[];
  auth: Record<string, unknown>;
  ownership: "org" | "personal" | null;
}

/** `GET /orgs/:orgId/catalog/:itemId` (kernel `OrgCatalogDetail`, latest version). */
export interface OrgCatalogDetail {
  item: OrgCatalogItem;
  hasIcon: boolean;
  /** The plugin's extension (its name), null without one. */
  extension: string | null;
  templates: OrgCatalogTemplate[];
  dependencies: { name: string; range: string }[];
  /** The skill directories. */
  skills: string[];
}

/** What an org fills in for one connector template at install. */
export interface ConnectorInstallInput {
  name?: string;
  slug?: string;
  endpoint?: Record<string, unknown>;
  credential?: Record<string, unknown>;
  client?: { clientId: string; clientSecret?: string };
}

/** The org install body: template input by template id, the plugin's own extension's org config. */
export interface OrgInstallBody {
  version?: string;
  connectors?: Record<string, ConnectorInstallInput>;
  extensionConfig?: Record<string, unknown>;
}

/** Install result: installed (201) or a request was created (202, needs enterprise admin approval). */
export type OrgInstallResult =
  | {
      installed: { itemId: string; version: string; pluginInstallId: string };
      install: PluginInstall;
    }
  | { request: CatalogRequest };

/** `plugin` is a dependency install (ref = its plugin install id). */
export type ComponentKind = "extension" | "connector" | "skill" | "plugin";

/** An installed plugin (kernel `PluginInstallView`). */
export interface PluginInstall {
  id: string;
  itemId: string;
  name: string;
  version: string;
  status: "installing" | "installed" | "failed" | "uninstalling" | "upgrading";
  installedBy: string | null;
  installedAt: string;
  /** The failed install's step and code, or the last failed upgrade's (the install stays installed). */
  error: { step: string; code: string } | null;
  /** `dropped`: an upgrade removed it from the plugin but kept it because something still uses it. */
  components: {
    kind: ComponentKind;
    ref: string;
    created: boolean;
    skillVersion?: number | null;
    dropped: boolean;
  }[];
  /** The highest version this install can be upgraded to now, null when none. */
  upgradeAvailable: string | null;
  /** The deployment runs another version of the plugin's extension: upgrade this org's plugin. */
  deploymentPending: boolean;
}

/** How a component differs between the installed and the target version. */
export type UpgradeChange = "added" | "changed" | "removed" | "unchanged";

/** One component of an upgrade preview (`ref`: extension / dependency / skill name, template id). */
export interface UpgradeComponent {
  kind: ComponentKind;
  ref: string;
  change: UpgradeChange;
  detail?: string;
}

/** `POST …/plugin-installs/:installId/upgrade/preview` (kernel `UpgradePreview`). */
export interface UpgradePreview {
  from: string;
  to: string;
  /** Sent back with the upgrade; it changes when the target, the components or the inputs change. */
  diffHash: string;
  components: UpgradeComponent[];
  inputs: {
    /** Added templates: their connectors are created with the org's input. */
    connectors: string[];
    /** Changed templates whose auth method or required credentials changed: re-entry needed. */
    credentialsChanged: string[];
    /** The extension is added and not yet enabled in the org: its org config may be given. */
    extensionConfig: boolean;
  };
  /** The target version's templates named in the inputs (the input form is built from them). */
  templates: OrgCatalogTemplate[];
}

/** The upgrade body: the target, the preview's diffHash and the inputs it listed. */
export interface PluginUpgradeBody extends Omit<OrgInstallBody, "version"> {
  version: string;
  diffHash: string;
}

/** Upgraded (200), or a request was created (202, the item needs enterprise admin approval). */
export type PluginUpgradeResult = { install: PluginInstall } | { request: CatalogRequest };

export const KEPT_REASONS = [
  "pre_existing",
  "used_by_agents",
  "used_by_other_install",
  "used_by_connectors",
  "used_by_plugins",
] as const;
export type KeptReason = (typeof KEPT_REASONS)[number];

/** An uninstall report (kernel `UninstallReport`). */
export interface UninstallReport {
  removed: { kind: ComponentKind; ref: string }[];
  kept: { kind: ComponentKind; ref: string; reason: KeptReason }[];
}

const enc = encodeURIComponent;
const post = (body?: unknown): RequestInit => ({
  method: "POST",
  ...(body !== undefined && { body: JSON.stringify(body) }),
});
const admin = "/api/v1/admin/catalog";
const marketplaces = "/api/v1/admin/marketplaces";
const org = (orgId: string) => `/api/v1/orgs/${enc(orgId)}`;

// ---- Deployment level: items ----

export const listCatalogItems = () =>
  apiFetch<{ items: CatalogItem[]; nextOffset: number | null }>(`${admin}/items?limit=1000`);

export const getCatalogItem = (id: string) =>
  apiFetch<CatalogItemDetail>(`${admin}/items/${enc(id)}`);

export const setCatalogPolicy = (id: string, policy: CatalogPolicy) =>
  apiFetch<CatalogItem>(`${admin}/items/${enc(id)}/policy`, {
    method: "PUT",
    body: JSON.stringify({ policy }),
  });

export const removeCatalogItem = (id: string) =>
  apiFetch<void>(`${admin}/items/${enc(id)}`, { method: "DELETE" });

/** Installs the extension of a version of the item on the deployment (`catalog.no_extension` without one). */
export const installItemToDeployment = (id: string, version: string) =>
  apiFetch<AdminExtension>(`${admin}/items/${enc(id)}/install-deployment`, post({ version }));

/** Admin icon URL (only used as an `<img>` source). */
export const adminIconUrl = (id: string) => `${admin}/items/${enc(id)}/icon`;

// ---- Deployment level: the plugin import ----

/** Prepares the import of a plugin from npm (`version` may be a version, dist-tag or range). */
export const preparePluginNpm = (pkg: string, version: string) =>
  apiFetch<PluginPrepared>(
    `${admin}/import/npm`,
    post({ package: pkg, ...(version !== "" && { version }) }),
  );

/**
 * Prepares the import of an uploaded plugin package (raw bytes, streamed by the kernel). Checks the
 * session first (the proxy streams the body through, and a stream cannot be replayed).
 */
export async function uploadPluginPackage(file: Blob): Promise<PluginPrepared> {
  await ensureSession();
  const res = await fetch(`${admin}/import/file`, {
    method: "POST",
    credentials: "same-origin",
    headers: { [CSRF_HEADER]: "1", "content-type": "application/octet-stream" },
    body: file,
  }).catch((e: unknown) => {
    throw new ApiClientError(0, "network", e instanceof Error ? e.message : String(e));
  });
  if (!res.ok) throw await toError(res);
  return (await res.json()) as PluginPrepared;
}

/**
 * Prepares a one-off import straight from git: `url` is an https git URL or `owner/repo`, `ref` a
 * branch / tag / commit (default the remote HEAD), `path` the plugin's directory (default the root).
 */
export const preparePluginGit = (url: string, ref: string, path: string) =>
  apiFetch<PluginPrepared>(
    `${admin}/import/git`,
    post({ url, ...(ref !== "" && { ref }), ...(path !== "" && { path }) }),
  );

/**
 * Confirms a staged import; `deployExtension` also installs and enables the plugin's extension;
 * `pinnedSuggestions` (skill names of the review) replaces the plugin's suggested pinned skills.
 */
export const confirmPluginImport = (
  stagingId: string,
  body: { reviewHash: string; deployExtension: boolean; pinnedSuggestions?: string[] },
) => apiFetch<PluginConfirmResult>(`${admin}/imports/${enc(stagingId)}/confirm`, post(body));

/**
 * A staged import's review, with a marketplace import's permission mismatch when there is one
 * (`plugin.staging_not_found` once expired or confirmed).
 */
export const getStagedImport = (stagingId: string) =>
  apiFetch<PluginPrepared>(`${admin}/imports/${enc(stagingId)}`);

/** The import page of a staged import (it loads the review with {@link getStagedImport}). */
export const importPageHref = (stagingId: string) =>
  `/admin/catalog/import?staging=${enc(stagingId)}`;

// ---- Deployment level: requests ----

export const listDeploymentRequests = () =>
  apiFetch<{ requests: CatalogRequest[] }>(`${admin}/requests?status=pending`);

export const decideDeploymentRequest = (id: string, decision: "approve" | "reject") =>
  apiFetch<{ request: CatalogRequest }>(`${admin}/requests/${enc(id)}/decide`, post({ decision }));

// ---- Deployment level: marketplaces ----

export const listMarketplaces = () =>
  apiFetch<{ items: Marketplace[]; offline: boolean }>(marketplaces);

/** Adds an enterprise marketplace; `form: "git"` with an optional `ref` for a git repository. */
export const addMarketplace = (body: {
  name: string;
  url: string;
  form?: MarketplaceForm;
  ref?: string;
  token?: string;
}) => apiFetch<Marketplace>(marketplaces, post(body));

/** `ref: null` makes a git marketplace follow the remote HEAD again. */
export const updateMarketplace = (
  id: string,
  body: {
    name?: string;
    url?: string;
    form?: MarketplaceForm;
    ref?: string | null;
    enabled?: boolean;
    token?: string | null;
  },
) =>
  apiFetch<Marketplace>(`${marketplaces}/${enc(id)}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });

export const removeMarketplace = (id: string) =>
  apiFetch<void>(`${marketplaces}/${enc(id)}`, { method: "DELETE" });

export const refreshMarketplace = (id: string) =>
  apiFetch<Marketplace>(`${marketplaces}/${enc(id)}/refresh`, post());

export const listMarketplaceEntries = (q: { sourceId?: string; q?: string } = {}) => {
  const params = new URLSearchParams();
  if (q.sourceId) params.set("sourceId", q.sourceId);
  if (q.q) params.set("q", q.q);
  const qs = params.toString();
  return apiFetch<{ items: MarketplaceEntry[]; truncated?: boolean }>(
    `${marketplaces}/entries${qs === "" ? "" : `?${qs}`}`,
  );
};

/** Prepares the import of a marketplace entry (null version: the newest compatible one). */
export const importMarketplaceEntry = (
  e: Pick<MarketplaceEntry, "sourceId" | "name">,
  version: string | null,
) =>
  apiFetch<PluginPrepared>(
    `${marketplaces}/${enc(e.sourceId)}/entries/${enc(e.name)}/import`,
    post(version === null ? {} : { version }),
  );

// ---- Org side ----

export const listOrgCatalog = (orgId: string) =>
  apiFetch<{ items: OrgCatalogItem[] }>(`${org(orgId)}/catalog`);

export const getOrgCatalogItem = (orgId: string, itemId: string) =>
  apiFetch<OrgCatalogDetail>(`${org(orgId)}/catalog/${enc(itemId)}`);

export const orgIconUrl = (orgId: string, itemId: string) =>
  `${org(orgId)}/catalog/${enc(itemId)}/icon`;

export const requestCatalogItem = (orgId: string, itemId: string, note: string) =>
  apiFetch<{ request: CatalogRequest; created: boolean }>(
    `${org(orgId)}/catalog/${enc(itemId)}/requests`,
    post(note === "" ? {} : { note }),
  );

export const installCatalogItem = (orgId: string, itemId: string, body: OrgInstallBody) =>
  apiFetch<OrgInstallResult>(`${org(orgId)}/catalog/${enc(itemId)}/install`, post(body));

export const listPluginInstalls = (orgId: string) =>
  apiFetch<{ installs: PluginInstall[] }>(`${org(orgId)}/plugin-installs`);

export const uninstallPlugin = (orgId: string, installId: string) =>
  apiFetch<UninstallReport>(`${org(orgId)}/plugin-installs/${enc(installId)}`, {
    method: "DELETE",
  });

/** Previews upgrading an installed plugin to `version` (the components and the inputs needed). */
export const previewPluginUpgrade = (orgId: string, installId: string, version: string) =>
  apiFetch<UpgradePreview>(
    `${org(orgId)}/plugin-installs/${enc(installId)}/upgrade/preview`,
    post({ version }),
  );

/** Upgrades an installed plugin with the preview's `diffHash` (409 `plugin.upgrade_stale` once it changed). */
export const upgradePlugin = (orgId: string, installId: string, body: PluginUpgradeBody) =>
  apiFetch<PluginUpgradeResult>(
    `${org(orgId)}/plugin-installs/${enc(installId)}/upgrade`,
    post(body),
  );

export const decideOrgRequest = (orgId: string, id: string, decision: "approve" | "reject") =>
  apiFetch<{ request: CatalogRequest }>(
    `${org(orgId)}/catalog-requests/${enc(id)}/decide`,
    post({ decision }),
  );

// ---- 纯函数 ----

/** 显示名：有双语名按界面语言取，否则用条目名。 */
export const displayNameOf = (
  i: { name: string; displayName: LocalizedName | null },
  locale: string,
): string => (i.displayName ? (locale === "zh" ? i.displayName.zh : i.displayName.en) : i.name);

/** 申请人：显示名，账号已删除时退回账号 id，都没有为「—」。 */
export const requesterOf = (r: Pick<CatalogRequest, "requestedBy" | "requestedByName">): string =>
  r.requestedByName ?? r.requestedBy ?? "—";

/** An item's source filter key: `manual` (file / npm import) or `marketplace:<marketplace id>`. */
export const sourceKeyOf = (i: Pick<CatalogItem, "marketplaceId">): string =>
  i.marketplaceId === null ? "manual" : `marketplace:${i.marketplaceId}`;

/** 对象的叶子点路径与值（数组与非对象值算叶子），用于展示端点预设。 */
export function endpointLeaves(v: Record<string, unknown>, base = ""): [string, unknown][] {
  const out: [string, unknown][] = [];
  for (const [k, x] of Object.entries(v)) {
    const p = base === "" ? k : `${base}.${k}`;
    if (typeof x === "object" && x !== null && !Array.isArray(x) && Object.keys(x).length > 0) {
      out.push(...endpointLeaves(x as Record<string, unknown>, p));
    } else out.push([p, x]);
  }
  return out;
}

/** 端点里某个点路径的值。 */
export function getPath(v: unknown, path: string): unknown {
  let node: unknown = v;
  for (const seg of path.split(".")) {
    if (typeof node !== "object" || node === null || !Object.hasOwn(node, seg)) return undefined;
    node = (node as Record<string, unknown>)[seg];
  }
  return node;
}

/** 按点路径写入（中间层不存在就建对象）。 */
export function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const segs = path.split(".");
  let node = obj;
  for (const seg of segs.slice(0, -1)) {
    const next = node[seg];
    if (typeof next !== "object" || next === null || Array.isArray(next)) node[seg] = {};
    node = node[seg] as Record<string, unknown>;
  }
  node[segs[segs.length - 1] as string] = value;
}

/** 端点里一个值的展示文本。 */
export const showValue = (v: unknown): string =>
  v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v);

/** 认证预设是不是 OAuth（组织填客户端 id / secret，而不是静态凭据）。 */
export const isOAuth = (auth: Record<string, unknown>): boolean =>
  auth.type === "oauth_code" || auth.type === "oauth_client";

/** Whether a review has sensitive items (the plugin, its extension, or migration warnings). */
export const pluginReviewSensitive = (r: PluginReview): boolean =>
  r.sensitive ||
  r.extension?.sensitive === true ||
  (r.extension !== undefined && r.extension.warnings.length > 0);

/** The last segment of a plugin.json path (`./skills/pdf-tools` -> `pdf-tools`). */
const baseName = (path: string): string => path.replace(/\/+$/, "").split("/").pop() ?? path;

/** A skill's directory name from plugin.json `skills[].path`. */
export const skillNameOf = (path: string): string => baseName(path);

/** A connector template's id from plugin.json `connectorTemplates[].path` (`./connectors/gh.json` -> `gh`). */
export const templateIdOf = (path: string): string => baseName(path).replace(/\.json$/i, "");

/**
 * The permissions an extension declares in its static manifest, by category (the categories of the
 * kernel's permission view; empty ones left out). Only for display: the import review shows the
 * kernel's grouping with the sensitive items.
 */
export function declaredPermissions(
  m: StaticExtensionManifest,
): { category: string; items: string[] }[] {
  const p = m.permissions;
  const http = p.http ?? [];
  const groups = [
    { category: "provides", items: m.provides },
    { category: "requires", items: m.requires },
    { category: "optional", items: m.optional },
    { category: "secrets", items: p.secrets ? ["secrets"] : [] },
    { category: "storage", items: p.storage ? ["storage"] : [] },
    {
      category: "http",
      items: http.filter((r) => r.public !== true).map((r) => `${r.method} ${r.path}`),
    },
    {
      category: "publicRoutes",
      items: http.filter((r) => r.public === true).map((r) => `${r.method} ${r.path}`),
    },
    { category: "tools", items: p.tools ?? [] },
    {
      category: "hooks",
      items: [...(p.hooks ?? []), ...(p.policyHooks ?? []).map((h) => `policy:${h}`)],
    },
    { category: "models", items: (p.models ?? []).map((x) => x.purpose) },
    { category: "network", items: p.network ?? [] },
    { category: "ui", items: [...(p.ui?.views ?? []), ...(p.ui?.embeds ?? [])] },
  ];
  return groups.filter((g) => g.items.length > 0);
}

/** A short commit for display (the first 7 characters). */
export const shortCommit = (sha: string): string => sha.slice(0, 7);

/** A git location in one line: `host/repo`, with the directory when it is not the root. */
export const gitLocation = (d: Pick<GitSourceDetail, "host" | "repo" | "path">): string =>
  d.path === "." || d.path === "" ? `${d.host}/${d.repo}` : `${d.host}/${d.repo} (${d.path})`;

/** The host of a marketplace entry's git or archive source (what `marketplaces.allowedHosts` checks). */
export function entryHost(s: MarketplaceSource): string | null {
  const url = "git" in s ? s.git.url : "archive" in s ? s.archive.url : null;
  if (url === null) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** One skill of a `plugin.skill_conflict` error: the org's own skill, or another plugin's. */
export type SkillConflict = {
  skill: string;
  source: { kind: "org" } | { kind: "plugin"; name: string; version: string };
};

/** The skills a `plugin.skill_conflict` error names (its envelope details), else empty. */
export function skillConflictsOfError(e: unknown): SkillConflict[] {
  if (!(e instanceof ApiClientError) || e.code !== "plugin.skill_conflict") return [];
  return e.rawDetails.flatMap((d): SkillConflict[] => {
    if (typeof d !== "object" || d === null) return [];
    const { skill, source } = d as Record<string, unknown>;
    if (typeof skill !== "string" || typeof source !== "object" || source === null) return [];
    const s = source as Record<string, unknown>;
    if (s.kind === "plugin" && typeof s.name === "string") {
      const version = typeof s.version === "string" ? s.version : "";
      return [{ skill, source: { kind: "plugin", name: s.name, version } }];
    }
    return [{ skill, source: { kind: "org" } }];
  });
}

/**
 * Codes whose envelope details name what the copy cannot (the host, repo, ref or commit, the
 * refused entry, why a version is not an upgrade target); rendered as localized detail lines.
 */
export const DETAILED_CODES = new Set([
  "marketplace.host_not_allowed",
  "marketplace.private_address",
  "marketplace.redirect",
  "marketplace.git_failed",
  "marketplace.git_too_large",
  "marketplace.git_unsupported_entry",
  "marketplace.path_unsupported",
  "plugin.upgrade_target_invalid",
]);

/** The string fields of the first envelope detail of a {@link DETAILED_CODES} error, else null. */
export function errorDetailOf(e: unknown): { code: string; detail: Record<string, string> } | null {
  if (!(e instanceof ApiClientError) || !DETAILED_CODES.has(e.code)) return null;
  const d = e.rawDetails[0];
  if (typeof d !== "object" || d === null) return null;
  const detail: Record<string, string> = {};
  for (const [k, v] of Object.entries(d as Record<string, unknown>)) {
    if (typeof v === "string") detail[k] = v;
  }
  return { code: e.code, detail };
}

/** A marketplace entry's source in one line (npm package, archive URL, git URL, repository path). */
export function marketplaceSourceText(s: MarketplaceSource): string {
  if ("npm" in s) return s.npm.package;
  if ("archive" in s) return s.archive.url;
  if ("git" in s) return s.git.path === undefined ? s.git.url : `${s.git.url} (${s.git.path})`;
  return s.path;
}

/**
 * The dependency a `catalog.dependency_*` error names (its envelope details carry no `message`, so
 * `issueLines` drops them): `{ dependency, range }` / `{ dependency }`, or the `cycle`.
 */
export function dependencyOfError(e: unknown): { dependency: string } | { cycle: string } | null {
  if (!(e instanceof ApiClientError) || !e.code.startsWith("catalog.dependency_")) return null;
  const d = e.rawDetails[0];
  if (typeof d !== "object" || d === null) return null;
  const { dependency, range, cycle } = d as Record<string, unknown>;
  if (typeof dependency === "string") {
    return { dependency: typeof range === "string" ? `${dependency} ${range}` : dependency };
  }
  if (Array.isArray(cycle) && cycle.every((x) => typeof x === "string")) {
    return { cycle: cycle.join(" → ") };
  }
  return null;
}
