import type { PackageWarning, SingleProviderBlock, SingleProviderNote } from "./admin-extensions";
import { ApiClientError, apiFetch, CSRF_HEADER, ensureSession, toError } from "./api";
import type { SuggestedAppearance } from "./appearance";
import type { Owner } from "./components";
import type { ExtensionUnavailableReason, PermissionGroup, PermissionItem } from "./extensions";

/**
 * The platform catalog (kernel `catalog/*.controller.ts`). Every catalog item is a plugin: an
 * optional extension, skills, connector templates and dependencies on other plugins.
 * - deployment level (super admins): `/api/v1/admin/catalog/*` items, the plugin import
 *   (prepare from a file or npm -> one review -> confirm, which also installs the extension), scope
 *   and disable (previewed, confirmed with `scopeHash`), permission confirmation, access / import
 *   requests; `/api/v1/admin/marketplaces/*` marketplaces, browsing
 *   their entries, preparing an import from one;
 * - org side: `/api/v1/orgs/:orgId/catalog*` browse, detail, switch on / off, `enable` / `access` /
 *   marketplace requests; `plugin-installs` the installed plugins and uninstall; the inbox's
 *   `catalog_request` is decided by org admins with `catalog-requests/:id/decide`.
 * Item icons come only from kernel routes (nosniff + CSP sandbox); the web shows them only in `<img>`,
 * never inline.
 */

/** Who a plugin is offered to (kernel `PluginScope`); a builtin plugin is always `all`. */
export const PLUGIN_SCOPES = ["all", "optional", "named"] as const;
export type PluginScope = (typeof PLUGIN_SCOPES)[number];

/** The effective state of a plugin in one org (kernel `OrgPluginState`). */
export type OrgPluginState = "on" | "off" | "needs_config" | "unavailable" | "not_offered";

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
  /**
   * The URL of its icon on this viewer's catalog icon route (the lists only); null or absent when
   * the latest version has none: draw the initial.
   */
  icon?: string | null;
  /** The English description. */
  description: string;
  /** The latest version's Chinese description; null without one (see {@link descriptionOf}). */
  descriptionZh: string | null;
  /** Who the plugin is offered to (`all` for a builtin plugin). */
  scope: PluginScope;
  /** The orgs of a `named` scope (empty otherwise). */
  scopeOrgs: string[];
  /** Orgs that switched an `all` item off (admin lists only; 0 for other scopes). */
  offCount?: number;
  /** Shipped with the deployment (a required bootstrap plugin): scope `all`, never changed. */
  builtin: boolean;
  /** Stopped on the whole deployment (its scope is kept). */
  disabled: boolean;
  /** Orgs outside a `named` item's list see it as requestable (`not_offered`). */
  shownToOthers: boolean;
  /** The platform, or the org that uploaded it (ruling P3-1). */
  owner: Owner;
  /** An org-owned item's owner shares it with other orgs (false for platform items). */
  shareable: boolean;
  /** An org's upload with an extension waits for the super admin's confirmation (P3-9). */
  awaitingConfirmation: boolean;
  /** The org-uploaded version that waits for that confirmation (null: none). */
  pendingVersion: string | null;
  /** Orgs it is on in. */
  enabledOrgs: number;
  /** Its extension waits for a person's confirmation (`POST items/:id/confirm`). */
  pending: boolean;
  /** The digest to send with the confirmation; null unless `pending` and the package is readable. */
  permissionsHash: string | null;
  latestVersion: string;
  versions: string[];
  installs: number;
  /** The latest version's source: file / npm / marketplace. */
  source: string;
  /** The marketplace it was imported from (`official` or a custom marketplace id), else null. */
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
  /** What the latest version brings, by kind (read-only). */
  componentCounts: ComponentCounts;
  /** The format the latest version was read from. */
  sourceFormat: PluginSourceFormat;
  updatedAt: string;
}

/** The components of a plugin version, by kind (kernel `ComponentCounts`). */
export interface ComponentCounts {
  extension: 0 | 1;
  skills: number;
  connectorTemplates: number;
  agentTemplates: number;
  themes: number;
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
    /** Client code: a browser bundle that runs in members' browsers. */
    client?: boolean;
    ui?: { views?: string[]; embeds?: string[]; components?: string[] };
  };
  config?: { deployment: { key: string }[]; org: { key: string }[] };
}

/** A version's normalized plugin.json (SDK `PluginManifest`, the parts the web reads). */
export interface PluginManifest {
  name: string;
  version: string;
  publisher: string;
  /** A string (English) or `{ en, zh? }`. */
  description: string | { en: string; zh?: string };
  displayName?: LocalizedName;
  icon?: string;
  license?: string;
  homepage?: string;
  dependencies?: { name: string; version: string }[];
  skills?: { path: string; pinned?: boolean }[];
  connectorTemplates?: { path: string }[];
  /** Agent templates (`agents/<name>.md`, phase C). */
  agents?: { path: string }[];
  extension?: {
    entry: string;
    manifest: StaticExtensionManifest;
    migrations?: string;
    ui?: string;
    /** Browser code, styles and assets (client extensions spec §4.1). */
    client?: PluginClientFiles;
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
  agent_imported: ["type", "model"],
  command_imported: [],
  mcp_template: ["template", "auth"],
  skill_root_relocated: ["to"],
  version_from_entry: ["version"],
  version_fallback: ["version"],
  publisher_from_marketplace: ["publisher"],
  dependency_mapped: ["version"],
  entry_components_merged: ["keys"],
  agent_model_mapped: ["from", "to"],
  agent_tools_inherited: [],
  skill_manual_only: [],
  skill_forked: ["agent"],
  mcp_header_variable: ["header", "variable"],
  mcp_url_variable: ["variable"],
  dependency_not_imported: ["version"],
  skill_manual_invocation: [],
  command_manual_invocation: [],
  skill_needs_subagents: [],
  agent_needs_subagents: [],
  command_invalid: [],
  agent_invalid: [],
  agent_field_ignored: ["keys"],
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
  agent_tools_unmapped: ["tools"],
  agent_tools_narrowed: ["tools"],
  agent_skills_truncated: ["skills"],
  skill_shell_injection: [],
  skill_agent_unknown: ["agent"],
  skill_invocation_key_ignored: ["keys"],
  skill_file_reference: ["files"],
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
  source: "file" | "npm" | "marketplace" | "git" | "bootstrap";
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
  /** The root LICENSE was too long (or not UTF-8) to store. */
  licenseTruncated?: boolean;
  /**
   * The extension package's client build (admin item detail only; null without one): what the
   * confirmation of an org's upload shows in its 客户端代码 group.
   */
  client?: ClientBuildSummary | null;
}

/**
 * A stored client build as the reviews show it (kernel `ClientBuildSummary`): each file by its
 * manifest key with its size, in load order, the total and the client API version.
 */
export interface ClientBuildSummary {
  files: { path: string; bytes: number }[];
  totalBytes: number;
  apiVersion: number;
}

export interface CatalogItemDetail {
  /** `packageName` is null for a git plugin without package.json. */
  item: CatalogItem & {
    packageName: string | null;
    deletedAt: string | null;
    /** The version the platform's components come from (an import does not move it). */
    platformVersion?: string;
  };
  versions: CatalogItemVersion[];
  /** The latest version has an icon (shown as `<img>` through the kernel route). */
  hasIcon: boolean;
  /** The platform version's suggested appearance (client extensions spec §6.5); null without one. */
  suggestedAppearance?: SuggestedAppearance | null;
}

/** The plugin's extension in an import review (kernel `PluginReviewExtension`). */
export interface PluginReviewExtension {
  name: string;
  version: string;
  sha256: string;
  /** install: not on the deployment; upgrade: another package is installed; keep: this one is. */
  action: "install" | "upgrade" | "keep";
  /** The import is below the deployed version: confirming keeps the deployed extension. */
  olderThanDeployed?: true;
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
  /**
   * The extension's client code (client extensions spec §5.4, §9.1): every file by its manifest
   * key with its size, entry first; absent without client code.
   */
  client?: PluginReviewClient;
}

/** The client code of an extension in an import review (kernel `PluginReviewClient`). */
export interface PluginReviewClient {
  files: { path: string; size: number }[];
  totalBytes: number;
  apiVersion: number;
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
  /** The English description. */
  description: string;
  /** The Chinese description; null without one (absent in reviews staged before it existed). */
  descriptionZh?: string | null;
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
  /** Agent templates (phase C; absent in reviews staged before it). */
  agentTemplates?: PluginReviewAgentTemplate[];
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

/**
 * An org's prepared upload (kernel `OrgUploadReview`): the review and, for a new version of the
 * org's own plugin without an extension, the platform update it applies at once (ruling P3-12;
 * the review's `reviewHash` covers both).
 */
export interface OrgUploadReview {
  stagingId: string;
  review: PluginReview;
  update: PlatformUpdatePreview | null;
}

/** What an org's confirmed upload did (kernel `OrgUploadOutcome`). */
export type OrgUploadOutcome = "installed" | "pending" | "updated";

/** What deleting an org's own plugin does (kernel `OwnedDeletePreview`, ruling P3-19). */
export interface OwnedDeletePreview {
  outcome: "removed" | "transferred";
  /** The other orgs using it (it is transferred to the platform). */
  orgs: { id: string; name: string }[];
  /** The org's agents that lose it. */
  agents: { id: string; name: string }[];
  previewHash: string;
}

/** Deploying the plugin's extension after confirm (kernel `ExtensionDeployResult`). */
export interface PluginDeployResult {
  name: string;
  action: "install" | "upgrade";
  version: string;
  sha256: string;
  /** `installed`: left disabled, see `singleProvider`. */
  result: "enabled" | "installed" | "failed";
  code?: string;
  message?: string;
  /** e.g. `snapshot_not_restored: …` when an upgrade failed and the snapshot had changed since. */
  note?: string;
  /**
   * Installed but left disabled (code `extension.single_provider_enabled`): another enabled
   * extension provides this single-provider extension point; disable it first, then enable this.
   */
  singleProvider?: SingleProviderBlock;
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

/**
 * What a marketplace's last refresh error was about, read from the kernel's English text
 * (`Marketplace.lastError` carries no code): each kind has its own sentence on the sources page,
 * `unknown` the generic one; the raw text stays behind the ErrorDetail toggle.
 */
export const MARKETPLACE_ERROR_KINDS = [
  "private_address",
  "dns",
  "timeout",
  "http_status",
  "invalid",
  "unknown",
] as const;
export type MarketplaceErrorKind = (typeof MARKETPLACE_ERROR_KINDS)[number];

const MARKETPLACE_ERROR_PATTERNS: [Exclude<MarketplaceErrorKind, "unknown">, RegExp][] = [
  // net.private_address (the network rules), also inside a git "cannot list the refs" line
  ["private_address", /private or reserved address|link-local address/],
  ["dns", /Cannot resolve /],
  ["timeout", /timed out/i],
  ["http_status", /\bHTTP \d{3}\b/],
  ["invalid", /not valid JSON|is not valid|does not match/],
];

export function marketplaceErrorKind(raw: string): MarketplaceErrorKind {
  return MARKETPLACE_ERROR_PATTERNS.find(([, re]) => re.test(raw))?.[0] ?? "unknown";
}

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
  /** The entry's display name (from the plugin's plugin.json); null without one: show the name. */
  displayName: LocalizedName | null;
  minKernel: string | null;
  homepage: string | null;
  permissions: { keys: string[]; sensitive: string[] } | null;
  source: MarketplaceSource;
  /**
   * The marketplace deprecates this version (its reason, null without one): shown under 其他版本
   * with 已废弃, never imported (the kernel refuses with `marketplace.entry_deprecated`). Older
   * kernels leave it out.
   */
  deprecated?: { reason: string | null } | null;
  compatible: boolean;
  /** The kernel can import this entry (see `reason` when it cannot). */
  importable: boolean;
  /** host_not_allowed: outside `marketplaces.allowedHosts`; a path entry of an http marketplace. */
  reason?: "host_not_allowed" | "path_needs_git_marketplace";
  adopted: { itemId: string; versions: string[] } | null;
  /**
   * The icon's kernel URL (super admins): an imported plugin's catalog icon (the one 已安装
   * shows), else the icon the marketplace gives for the entry; null (or absent from older kernels)
   * without one: the row draws the initial.
   */
  icon?: string | null;
  newerAvailable: boolean;
  /**
   * A version of this release is imported, but the entry now points at other content (a moved
   * branch, a new marketplace commit, another integrity); importing again records a build version.
   */
  contentChanged: boolean;
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Semver precedence of two versions (build metadata ignored, as the kernel's `compareVersions`):
 * negative when `a` is older, positive when newer, 0 for the same release; null when either is not
 * semver.
 */
export function compareSemver(a: string, b: string): number | null {
  const x = SEMVER.exec(a);
  const y = SEMVER.exec(b);
  if (x === null || y === null) return null;
  for (let i = 1; i <= 3; i++) {
    const d = Number(x[i]) - Number(y[i]);
    if (d !== 0) return Math.sign(d);
  }
  const [pa, pb] = [x[4], y[4]];
  if (pa === undefined || pb === undefined) return pa === pb ? 0 : pa === undefined ? 1 : -1;
  const ia = pa.split(".");
  const ib = pb.split(".");
  for (let i = 0; i < Math.max(ia.length, ib.length); i++) {
    const [u, v] = [ia[i], ib[i]];
    if (u === undefined) return -1;
    if (v === undefined) return 1;
    if (u === v) continue;
    const [nu, nv] = [/^\d+$/.test(u), /^\d+$/.test(v)];
    if (nu && nv) return Math.sign(Number(u) - Number(v));
    if (nu !== nv) return nu ? -1 : 1;
    return u < v ? -1 : 1;
  }
  return 0;
}

/** Whether the marketplace deprecates the entry. */
export const entryDeprecated = (e: MarketplaceEntry): boolean =>
  e.deprecated !== undefined && e.deprecated !== null;

/** A semver prerelease (`1.0.0-rc.0`); an entry without a version is not one. */
const isPrerelease = (version: string | null): boolean =>
  version !== null && SEMVER.exec(version)?.[4] !== undefined;

/** One plugin of one marketplace: its entries, newest first; `latest` is the row's version. */
export interface MarketplacePlugin {
  key: string;
  latest: MarketplaceEntry;
  /** The other versions, newest first. */
  others: MarketplaceEntry[];
}

/**
 * Groups marketplace entries (one per version) into one row per (marketplace, plugin), in the order
 * the plugins first appear. Versions are ordered by semver, newest first; a version that is not
 * semver keeps its place in the kernel's order (newest first). The latest is the kernel's default
 * import (`pickDefaultEntry` of marketplaces.service.ts): the newest stable versioned entry that
 * can be imported (compatible, importable, not deprecated), else the newest prerelease that can be
 * (prereleases fold into 其他版本 while a stable one can be imported), else the entry without a
 * version that is not deprecated, else the newest versioned one that is not deprecated, else the
 * entry without a version, else the newest.
 */
export function groupMarketplaceEntries(entries: readonly MarketplaceEntry[]): MarketplacePlugin[] {
  const groups = new Map<string, MarketplaceEntry[]>();
  for (const e of entries) {
    const key = `${e.sourceId}/${e.name}`;
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [e]);
    else list.push(e);
  }
  return [...groups].map(([key, list]) => {
    const sorted = [...list].sort((a, b) =>
      a.version === null || b.version === null ? 0 : (compareSemver(b.version, a.version) ?? 0),
    );
    const usable = (e: MarketplaceEntry) => e.compatible && e.importable && !entryDeprecated(e);
    const versioned = sorted.filter((e) => e.version !== null);
    const bare = sorted.filter((e) => e.version === null);
    const latest =
      versioned.find((e) => usable(e) && !isPrerelease(e.version)) ??
      versioned.find(usable) ??
      bare.find((e) => !entryDeprecated(e)) ??
      versioned.find((e) => !entryDeprecated(e)) ??
      bare[0] ??
      (versioned[0] as MarketplaceEntry);
    return { key, latest, others: sorted.filter((e) => e !== latest) };
  });
}

/** What a request asks for (kernel `CatalogRequestKind`). */
export type CatalogRequestKind = "access" | "import" | "enable" | "connector_setup";

/**
 * One connector a `connector_setup` request still needs (kernel `SetupRequestConnector`, ruling
 * P4-7): `key` is the bind route's key; `source` the platform connector template (its id and
 * display name) or the protocol, endpoint and tools a custom connector must offer.
 */
export interface SetupRequestConnector {
  key: string;
  label: string;
  kind: "template" | "needs";
  source:
    | { template: { id: string; displayName: LocalizedName | null } }
    | { needs: { protocol: "mcp" | "openapi"; endpoint: string; tools: string[] } };
  /** The tools the agent takes once bound; null = all. */
  tools: string[] | null;
  /** Tool names with a tightened policy. */
  policies: string[];
}

/** A catalog request (kernel `CatalogRequestView`). */
export interface CatalogRequest {
  id: string;
  orgId: string;
  orgName: string;
  kind: CatalogRequestKind;
  /** null for an `import` request until its confirm writes the item. */
  item: { id: string; name: string; displayName: LocalizedName | null } | null;
  /** The marketplace entry of an `import` request. */
  entry: { marketplaceId: string | null; name: string; version: string | null } | null;
  status: "pending" | "approved" | "rejected" | "cancelled";
  note: string;
  /** The optional reason of a rejection. */
  reason: string | null;
  requestedBy: string | null;
  requestedByName: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  /** The prepared import of an approved `import` request that is not confirmed yet. */
  stagingId: string | null;
  /** A `connector_setup` request's agent (null for the other kinds; older kernels: absent). */
  agent?: { id: string; name: string; deleted: boolean } | null;
  /** A `connector_setup` request's remaining connectors (`[]` once closed; null otherwise). */
  connectors?: SetupRequestConnector[] | null;
  createdAt: string;
}

/** A `connector_setup` request (ruling P4-7): `item` and `entry` are null, `agent` is set. */
export const isSetupRequest = (r: Pick<CatalogRequest, "kind">): boolean =>
  r.kind === "connector_setup";

/** The decision body of a request: approve, or reject with an optional reason. */
export interface RequestDecision {
  approve: boolean;
  reason?: string;
}

/** A catalog item from the org's view (kernel `OrgCatalogItem`). */
export interface OrgCatalogItem
  extends Omit<
    CatalogItem,
    | "installs"
    | "marketplaceId"
    | "latestMarketplaceVersion"
    | "newerInMarketplace"
    | "scopeOrgs"
    | "offCount"
    | "enabledOrgs"
    | "pending"
    | "permissionsHash"
    | "shownToOthers"
    | "awaitingConfirmation"
    | "pendingVersion"
  > {
  /** The owner org only (absent for other orgs): its upload waits for the super admin (P3-9). */
  awaitingConfirmation?: boolean;
  /** The owner org only (absent for other orgs): the version waiting for that confirmation. */
  pendingVersion?: string | null;
  /** Who the plugin is offered to (`all` for a builtin plugin). */
  scope: PluginScope;
  /** Shipped with the deployment: on in every org, never switchable. */
  builtin: boolean;
  /** The effective state in this org. */
  state: OrgPluginState;
  /**
   * Only when `unavailable`: why (kernel `OrgCatalogItem.reason`): `plugin_disabled` (the super
   * admin disabled it), or its extension's reason. Older kernels leave it out.
   */
  reason?: "plugin_disabled" | ExtensionUnavailableReason;
  /** The org admin may switch it (never for builtin items; `all` items are on unless switched off). */
  switchable: boolean;
  /** The plugin's extension (or a template's connector extension) is not on the deployment. */
  notDeployed: boolean;
  /** This org's live plugin install of the item; `upgradeAvailable` the version it can move to now. */
  installed: { pluginInstallId: string; version: string; upgradeAvailable: string | null } | null;
  request: { id: string; kind: "access" | "enable"; createdAt: string } | null;
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
  /** The agent template files (`agents/<name>.md`; older kernels leave it out). */
  agents?: string[];
  /**
   * An installed `needs_config` plugin: the connector templates on in the org that miss a
   * connector there (补充配置 creates them); empty otherwise, absent from older kernels.
   */
  missingTemplates?: OrgCatalogTemplate[];
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
  connectors?: Record<string, ConnectorInstallInput>;
  extensionConfig?: Record<string, unknown>;
}

/** What switching a plugin off in an org takes away (kernel `UninstallPreview`). */
export interface UninstallPreview {
  installId: string;
  name: string;
  version: string;
  components: { kind: ComponentKind; ref: string; created: boolean }[];
  kept: { kind: ComponentKind; ref: string; reason: KeptReason }[];
  agents: { id: string; name: string; uses: { kind: ComponentKind; ref: string }[] }[];
  /** The plugin's themes that go off in the org: its default? who picked them (themes spec §6). */
  themes?: ThemePreview[];
}

/**
 * One theme a change takes away (kernel `ThemePreview`, themes spec §6): the orgs losing it whose
 * default it is, and how many of their members picked it. `id` is the `platform_themes` id.
 */
export interface ThemePreview {
  id: string;
  orgDefaults: { orgId: string; orgName: string }[];
  pickedBy: number;
}

/** The switch-off preview and the hash that confirms it (`PUT …/switch`, org extension `PUT`). */
export interface SwitchPreview {
  preview: UninstallPreview;
  confirm: string;
}

/** `PUT /orgs/:orgId/catalog/:itemId/switch` body: on (with the install inputs), or off (with the hash). */
export type OrgSwitchBody =
  | { enabled: true; inputs?: OrgInstallBody }
  | { enabled: false; confirm?: string };

/** What a scope change or a disable would take away (kernel `ScopePreview`). */
export interface ScopePreview {
  affected: {
    orgId: string;
    orgName: string;
    agents: { id: string; name: string }[];
    /** The connectors the plugin created there; they stay as the org's own. */
    connectorsKept: number;
  }[];
  needsConfig: string[];
  /** A scope change: the plugin's components with their own scope, which then follow it again. */
  replaced?: { kind: string; id: string; name: string }[];
  /** Orgs that would newly be offered a skill whose name their own skills use: refused. */
  conflicts?: ScopeConflict[];
  /** The plugin's themes the change takes away from some orgs. */
  themes?: ThemePreview[];
  scopeHash: string;
}

/** An org whose own skills already use the name of a skill a change would offer it (rule 10). */
export interface ScopeConflict {
  orgId: string;
  orgName: string;
  name: string;
  /** The clashing skill ids and the plugins they come from. */
  skills: string[];
  plugins: string[];
}

/** `{ scope, orgs? }` (a scope change) or `{ disabled: true }` (a disable). */
export type ScopeTarget = { scope: PluginScope; orgs?: string[] } | { disabled: true };

/** `plugin` is a dependency install (ref = its plugin install id). */
export type ComponentKind = "extension" | "connector" | "skill" | "plugin" | "agent_template";

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

/** How a platform component differs between the platform's and the target version (spec §7.1). */
export type UpdateChange = "added" | "removed" | "upgrade" | "downgrade" | "same";

/** One component of a platform update preview (kernel `PlatformUpdateComponent`). */
export interface PlatformUpdateComponent {
  kind: "skill" | "agent_template" | "connector_template";
  /** The platform component (null: added by the target). */
  id: string | null;
  /** Skill or agent template name; a connector template's id. */
  name: string;
  change: UpdateChange;
  from: string | null;
  to: string | null;
  /** Updated on its own (spec §7.2): the confirm moves it to the plugin's version. */
  updatedOnOwn: boolean;
  /** It has its own scope: the update keeps it. */
  ownScope: boolean;
  /** Orgs whose copy is pinned to its own version: the confirm clears the pins. */
  pinnedOrgs: string[];
  /** A removed component agents still use: it stays, with the orgs and agents using it. */
  kept?: { orgId: string; agents: { id: string; name: string }[] }[];
}

/** The org connectors a platform update touches (kernel `PlatformUpdateConnectorOrg`). */
export interface PlatformUpdateConnectorOrg {
  orgId: string;
  connectors: { id: string; name: string; templateId: string; credentialsReset: boolean }[];
  /** Templates the update turns on (added, or no longer shipped off): their connectors need the org's input. */
  needsConfig: string[];
  /** Templates now shipped off that turn off in the org; their connectors stay. Absent when none. */
  turnedOff?: {
    templateId: string;
    agents: { id: string; name: string }[];
    connectorsKept: number;
  }[];
}

/** `POST /api/v1/admin/catalog/items/:id/update/preview` (kernel `PlatformUpdatePreview`). */
export interface PlatformUpdatePreview {
  itemId: string;
  name: string;
  from: string | null;
  to: string;
  components: PlatformUpdateComponent[];
  /**
   * The deployment's extension moves (one version for every org using it); null: unchanged. `to`
   * null: the version drops the extension (an owner update only).
   */
  extension: {
    from: string | null;
    to: string | null;
    orgs: string[];
    needsApproval: boolean;
  } | null;
  connectorOrgs: PlatformUpdateConnectorOrg[];
  /**
   * The names of the orgs the preview mentions, by id (an owner's update preview, Task 9: an org
   * admin cannot read other orgs' names); absent from kernels that do not send it.
   */
  orgNames?: Record<string, string>;
  /** The themes the update removes that are on in some org. */
  themes?: ThemePreview[];
  /** Confirm with it; 409 `plugin.upgrade_stale` once what the update does changed. */
  diffHash: string;
}

/** `PUT /api/v1/admin/catalog/items/:id/update` (kernel `PlatformUpdateResult`). */
export interface PlatformUpdateResult {
  itemId: string;
  version: string;
  components: PlatformUpdateComponent[];
  extension: PlatformUpdatePreview["extension"];
  connectorOrgs: PlatformUpdateConnectorOrg[];
  /**
   * The update installed the extension but left it disabled: a single-provider extension point it
   * provides is held by another enabled extension (`required`: by a required plugin).
   */
  extensionLeftDisabled?: SingleProviderNote;
}

export const KEPT_REASONS = [
  "pre_existing",
  "used_by_agents",
  "used_by_other_install",
  "used_by_connectors",
  "used_by_plugins",
  "wanted_by_scope",
  "org_owned",
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

/** The items waiting for a permission confirmation (not paged). */
export const listPendingPlugins = () =>
  apiFetch<{ items: CatalogItem[]; nextOffset: number | null }>(`${admin}/items?pending=true`);

const put = (body: unknown): RequestInit => ({ method: "PUT", body: JSON.stringify(body) });

/** What a scope change or a disable would take away; `scopeHash` confirms it (409 `plugin.scope_stale`). */
export const previewScope = (id: string, body: ScopeTarget) =>
  apiFetch<ScopePreview>(`${admin}/items/${enc(id)}/scope/preview`, post(body));

export const setScope = (
  id: string,
  body: { scope: PluginScope; orgs?: string[]; scopeHash: string },
) => apiFetch<CatalogItem>(`${admin}/items/${enc(id)}/scope`, put(body));

/** Disables (with the `{ disabled: true }` preview's hash) or re-enables (no hash) on the deployment. */
export const setDisabled = (id: string, body: { disabled: boolean; scopeHash?: string }) =>
  apiFetch<CatalogItem>(`${admin}/items/${enc(id)}/disabled`, put(body));

/** Whether orgs outside a `named` item's list see it as requestable. */
export const setShownToOthers = (id: string, shownToOthers: boolean) =>
  apiFetch<CatalogItem>(`${admin}/items/${enc(id)}/shown`, put({ shownToOthers }));

/** What updating the platform plugin to `version` would do (nothing written). */
export const previewPlatformUpdate = (id: string, version: string) =>
  apiFetch<PlatformUpdatePreview>(`${admin}/items/${enc(id)}/update/preview`, post({ version }));

/** Updates the platform plugin with the preview's `diffHash` (409 `plugin.upgrade_stale` once it changed). */
export const updatePlatformPlugin = (id: string, body: { version: string; diffHash: string }) =>
  apiFetch<PlatformUpdateResult>(`${admin}/items/${enc(id)}/update`, put(body));

/** Confirms the item's extension permissions (`permissionsHash` from the item view). */
export const confirmPending = (id: string, body: { permissionsHash: string }) =>
  apiFetch<CatalogItem>(`${admin}/items/${enc(id)}/confirm`, post(body));

/**
 * Rejects an org upload's pending version (ruling P3-10; 204): a first version is removed, a new
 * version's pending state cleared. `reason` (optional) is told to the owner org.
 */
export const rejectPending = (id: string, reason?: string) =>
  apiFetch<void>(
    `${admin}/items/${enc(id)}/reject`,
    post(reason !== undefined && reason !== "" ? { reason } : {}),
  );

export const removeCatalogItem = (id: string) =>
  apiFetch<void>(`${admin}/items/${enc(id)}`, { method: "DELETE" });

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
 * Confirms a staged import (it also installs and enables the plugin's extension): `scope` (default
 * `optional`) and `orgs` (only with `named`) say who the plugin is offered to; `pinnedSuggestions`
 * (skill names of the review) replaces the plugin's suggested pinned skills.
 */
export const confirmPluginImport = (
  stagingId: string,
  body: {
    reviewHash: string;
    scope?: PluginScope;
    orgs?: string[];
    pinnedSuggestions?: string[];
  },
) => apiFetch<PluginConfirmResult>(`${admin}/imports/${enc(stagingId)}/confirm`, post(body));

/**
 * A staged import's review, with a marketplace import's permission mismatch when there is one
 * (`plugin.staging_not_found` once expired or confirmed).
 */
export const getStagedImport = (stagingId: string) =>
  apiFetch<PluginPrepared>(`${admin}/imports/${enc(stagingId)}`);

/** The import page of a staged import (it loads the review with {@link getStagedImport}). */
export const importPageHref = (stagingId: string) =>
  `/admin/plugins/import?staging=${enc(stagingId)}`;

// ---- Deployment level: requests ----

export const listDeploymentRequests = () =>
  apiFetch<{ requests: CatalogRequest[] }>(`${admin}/requests?status=pending`);

/** Approving an `import` request returns the prepared import (confirm it on the import page). */
export const decideDeploymentRequest = (id: string, decision: RequestDecision) =>
  apiFetch<{ request: CatalogRequest; import?: PluginPrepared }>(
    `${admin}/requests/${enc(id)}/decide`,
    post(decision),
  );

// ---- Deployment level: marketplaces ----

export const listMarketplaces = () =>
  apiFetch<{ items: Marketplace[]; offline: boolean }>(marketplaces);

/** Adds a custom marketplace; `form: "git"` with an optional `ref` for a git repository. */
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

/**
 * Prepares an org admin's upload of a plugin package (raw bytes, streamed by the kernel; spec
 * §14, ruling P3-7). Checks the session first (a stream cannot be replayed).
 */
export async function uploadOrgPluginPackage(orgId: string, file: Blob): Promise<OrgUploadReview> {
  await ensureSession();
  const res = await fetch(`${org(orgId)}/catalog/uploads/file`, {
    method: "POST",
    credentials: "same-origin",
    headers: { [CSRF_HEADER]: "1", "content-type": "application/octet-stream" },
    body: file,
  }).catch((e: unknown) => {
    throw new ApiClientError(0, "network", e instanceof Error ? e.message : String(e));
  });
  if (!res.ok) throw await toError(res);
  return (await res.json()) as OrgUploadReview;
}

/**
 * Confirms the org's staged upload: `shareable` only for a new plugin (default false). Never
 * `pinnedSuggestions`: a new version keeps the plugin's own (the kernel refuses them, 400).
 */
export const confirmOrgUpload = (
  orgId: string,
  stagingId: string,
  body: { reviewHash: string; shareable?: boolean },
) =>
  apiFetch<{
    item: OrgCatalogItem;
    outcome: OrgUploadOutcome;
    /** An update left the plugin's extension disabled (see `PlatformUpdateResult`). */
    extensionLeftDisabled?: SingleProviderNote;
  }>(`${org(orgId)}/catalog/uploads/${enc(stagingId)}/confirm`, post(body));

/** Sets 可共享 on the org's own plugin (P3-17). */
export const setOwnedShareable = (orgId: string, itemId: string, shareable: boolean) =>
  apiFetch<void>(`${org(orgId)}/owned-plugins/${enc(itemId)}/shareable`, put({ shareable }));

/** What deleting the org's own plugin does (nothing written). */
export const previewOwnedDelete = (orgId: string, itemId: string) =>
  apiFetch<OwnedDeletePreview>(`${org(orgId)}/owned-plugins/${enc(itemId)}/delete/preview`, post());

/** Deletes the org's own plugin after its preview (409 `catalog.preview_stale` once it changed). */
export const deleteOwned = (orgId: string, itemId: string, previewHash: string) =>
  apiFetch<void>(`${org(orgId)}/owned-plugins/${enc(itemId)}/delete`, post({ previewHash }));

/** Withdraws the org's pending upload of its plugin (ruling P3-10). */
export const withdrawPending = (orgId: string, itemId: string) =>
  apiFetch<void>(`${org(orgId)}/owned-plugins/${enc(itemId)}/pending`, { method: "DELETE" });

/** Whether the org owns the item (it uploaded it). */
export const ownedBy = (item: { owner?: Owner }, orgId: string): boolean =>
  item.owner?.kind === "org" && item.owner.orgId === orgId;

/**
 * Whose an item or component is, seen from the viewing org (spec §14, ruling P3-1): its own
 * (`self`), another org's shared with it (`org`, by name), or the platform's (also for older
 * answers without an owner). The one rule every owner badge and meta line follows.
 */
export type OwnerSide = { kind: "self" } | { kind: "org"; name: string } | { kind: "platform" };

export const ownerSide = (owner: Owner | undefined, orgId: string): OwnerSide =>
  owner?.kind !== "org"
    ? { kind: "platform" }
    : owner.orgId === orgId
      ? { kind: "self" }
      : { kind: "org", name: owner.name };

/** The org that owns the item, null for the platform's (older answers carry no owner). */
export const ownerOrgOf = (item: { owner?: Owner }): { orgId: string; name: string } | null =>
  item.owner?.kind === "org" ? item.owner : null;

/**
 * The share gate of an org-owned item (ruling P3-1, P3-16): its owner does not share it, so it is
 * not shown to or associated with other orgs and its scope only narrows. False for the platform's.
 */
export const shareGated = (item: { owner?: Owner; shareable?: boolean }): boolean =>
  ownerOrgOf(item) !== null && item.shareable !== true;

export const orgIconUrl = (orgId: string, itemId: string) =>
  `${org(orgId)}/catalog/${enc(itemId)}/icon`;

/** `enable`: a member asks an org admin to switch an off plugin on; `access`: an org admin asks for a `named` one. */
export const requestCatalogItem = (
  orgId: string,
  itemId: string,
  kind: "access" | "enable",
  note: string,
) =>
  apiFetch<{ request: CatalogRequest }>(
    `${org(orgId)}/catalog/${enc(itemId)}/requests`,
    post({ kind, ...(note !== "" && { note }) }),
  );

/** An org admin asks for a marketplace entry to be imported (deployment setting `orgMarketplaceBrowse`). */
export const requestMarketplaceEntry = (
  orgId: string,
  e: { marketplaceId: string; name: string; version: string },
  note: string,
) =>
  apiFetch<{ request: CatalogRequest }>(
    `${org(orgId)}/marketplace-requests`,
    post({ ...e, ...(note !== "" && { note }) }),
  );

/** The marketplaces' entries, read-only, for org admins (404 when `orgMarketplaceBrowse` is off). */
export const listOrgMarketplaceEntries = (
  orgId: string,
  q: { sourceId?: string; q?: string } = {},
) => {
  const params = new URLSearchParams();
  if (q.sourceId) params.set("sourceId", q.sourceId);
  if (q.q) params.set("q", q.q);
  const qs = params.toString();
  return apiFetch<{ items: MarketplaceEntry[]; truncated?: boolean }>(
    `${org(orgId)}/marketplaces/entries${qs === "" ? "" : `?${qs}`}`,
  );
};

/**
 * Switches a plugin on (with the install inputs), or off: the first off call answers
 * `{ preview, confirm }`, the second one carries `confirm` and answers `{ item }`.
 */
export const setOrgPluginSwitch = (orgId: string, itemId: string, body: OrgSwitchBody) =>
  apiFetch<{ item: OrgCatalogItem } | SwitchPreview>(
    `${org(orgId)}/catalog/${enc(itemId)}/switch`,
    put(body),
  );

/**
 * Creates the connectors an installed plugin misses (`needs_config`): one input per missing
 * template, checked like an install -> 201 `{ connectors }`.
 */
export const createPluginConnectors = (
  orgId: string,
  itemId: string,
  connectors: Record<string, ConnectorInstallInput>,
) =>
  apiFetch<{ connectors: { templateId: string; connectorId: string }[] }>(
    `${org(orgId)}/catalog/${enc(itemId)}/connectors`,
    post({ inputs: { connectors } }),
  );

/** The requester dismisses a decided request from the inbox (204). */
export const dismissOrgRequest = (orgId: string, id: string) =>
  apiFetch<void>(`${org(orgId)}/catalog-requests/${enc(id)}/dismiss`, post());

export const listPluginInstalls = (orgId: string) =>
  apiFetch<{ installs: PluginInstall[] }>(`${org(orgId)}/plugin-installs`);

/** Uninstalls a plugin install; a 409 `plugin.scope_locked` says an `all` / builtin plugin stays. */
export const uninstallPlugin = (orgId: string, installId: string) =>
  apiFetch<UninstallReport>(`${org(orgId)}/plugin-installs/${enc(installId)}`, {
    method: "DELETE",
  });

export const decideOrgRequest = (orgId: string, id: string, decision: RequestDecision) =>
  apiFetch<{ request: CatalogRequest }>(
    `${org(orgId)}/catalog-requests/${enc(id)}/decide`,
    post(decision),
  );

// ---- 纯函数 ----

/** The description in the UI language: the Chinese one in zh when there is one, else the English. */
export const descriptionOf = (
  i: { description: string; descriptionZh?: string | null },
  locale: string,
): string =>
  locale === "zh" && typeof i.descriptionZh === "string" ? i.descriptionZh : i.description;

/** 显示名：有双语名按界面语言取，否则用条目名。 */
export const displayNameOf = (
  i: { name: string; displayName: LocalizedName | null },
  locale: string,
): string => (i.displayName ? (locale === "zh" ? i.displayName.zh : i.displayName.en) : i.name);

/**
 * What a request is about: its catalog item, or (an `import` request before its confirm) the
 * marketplace entry's name; `id` is null while there is no item to link to.
 */
export const requestSubject = (
  r: Pick<CatalogRequest, "item" | "entry">,
): { id: string | null; name: string; displayName: LocalizedName | null } =>
  r.item ?? { id: null, name: r.entry?.name ?? "—", displayName: null };

/** The version a request names (an `import` request's entry), null when it names none. */
export const requestVersion = (r: Pick<CatalogRequest, "entry">): string | null =>
  r.entry?.version ?? null;

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

/** An agent template's name from plugin.json `agents[].path` (`./agents/reviewer.md` -> `reviewer`). */
export const agentTemplateNameOf = (path: string): string => baseName(path).replace(/\.md$/i, "");

/** An agent template in the import review (kernel `PluginReviewAgentTemplate`). */
export interface PluginReviewAgentTemplate {
  name: string;
  path: string;
  description: string;
  instructions: string;
  model: "inherit" | "fast" | "standard" | "capable";
  /** The tool allowlist; absent = the dispatching agent's tools. */
  tools?: string[];
  disallowedTools?: string[];
  toolPolicies?: Record<string, "ask" | "deny">;
  effort?: string;
  maxSteps?: number;
  skills?: string[];
}

/**
 * The permissions an extension declares in its static manifest, by category (the categories of the
 * kernel's permission view; empty ones left out). Only for display: the import review shows the
 * kernel's grouping with the sensitive items. Interface components and client code are groups of
 * their own and `sensitive` (client extensions spec §5.4: both block loading until approved); the
 * client group lists the files of the extension's `client` section when given (entry, styles,
 * assets, in that order), else the one key `permissions.client`.
 */
export function declaredPermissions(
  m: StaticExtensionManifest,
  client?: PluginClientFiles,
): { category: string; items: string[]; sensitive: boolean }[] {
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
    { category: "components", items: p.ui?.components ?? [], sensitive: true },
    {
      category: "client",
      items:
        p.client !== true
          ? []
          : client === undefined
            ? ["permissions.client"]
            : clientFilesOf(client),
      sensitive: true,
    },
  ];
  return groups
    .filter((g) => g.items.length > 0)
    .map((g) => ({ category: g.category, items: g.items, sensitive: g.sensitive === true }));
}

/** The files of a plugin.json `extension.client` section (SDK `PluginClientSection`). */
export interface PluginClientFiles {
  entry?: string;
  styles?: string[];
  assets?: string[];
}

/** A client section's files in load order: entry, styles, assets. */
export const clientFilesOf = (c: PluginClientFiles): string[] => [
  ...(c.entry !== undefined ? [c.entry] : []),
  ...(c.styles ?? []),
  ...(c.assets ?? []),
];

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
 * The owner a `plugin.name_taken` or `extension.name_conflict` error names (its envelope details
 * `[{ owner }]`, ruling P3-14), else null.
 */
export function ownerOfError(e: unknown): Owner | null {
  if (!(e instanceof ApiClientError)) return null;
  if (e.code !== "plugin.name_taken" && e.code !== "extension.name_conflict") return null;
  for (const d of e.rawDetails) {
    if (typeof d !== "object" || d === null) continue;
    const o = (d as Record<string, unknown>).owner;
    if (typeof o !== "object" || o === null) continue;
    const x = o as Record<string, unknown>;
    if (x.kind === "platform") return { kind: "platform" };
    if (x.kind === "org" && typeof x.orgId === "string" && typeof x.name === "string") {
      return { kind: "org", orgId: x.orgId, name: x.name };
    }
  }
  return null;
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
