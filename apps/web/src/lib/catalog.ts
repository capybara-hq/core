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

export interface CatalogItemVersion {
  version: string;
  source: "file" | "npm" | "marketplace";
  sourceRef: string;
  integrity: string | null;
  manifest: PluginManifest;
  size: number;
  /** The extension's package (null without an extension). */
  extensionSha256: string | null;
  importedAt: string;
}

export interface CatalogItemDetail {
  item: CatalogItem & { packageName: string; deletedAt: string | null };
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

/** The one review of a plugin import (kernel `PluginReview`). */
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
  /** Each dependency and the highest imported version satisfying its range (null: none yet). */
  dependencies: { name: string; range: string; resolved: string | null }[];
  source: { kind: "file" | "npm" | "marketplace"; ref: string };
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

/** A marketplace (kernel `MarketplaceView`). */
export interface Marketplace {
  id: string;
  name: string;
  url: string;
  mirrors: string[];
  builtin: boolean;
  enabled: boolean;
  disabledByConfig: boolean;
  hasToken: boolean;
  lastRefreshedAt: string | null;
  lastStatus: "ok" | "error" | "never";
  lastError: string | null;
  entryCount: number;
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
  minKernel: string | null;
  homepage: string | null;
  permissions: { keys: string[]; sensitive: string[] } | null;
  source: MarketplaceSource;
  compatible: boolean;
  /** The kernel can import this source now (`path` / `git` arrive with git marketplaces). */
  importable: boolean;
  reason?: "needs_git_marketplaces";
  adopted: { itemId: string; versions: string[] } | null;
  newerAvailable: boolean;
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
  /** This org's live plugin install of the item. */
  installed: { pluginInstallId: string; version: string } | null;
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
  status: "installing" | "installed" | "failed" | "uninstalling";
  installedBy: string | null;
  installedAt: string;
  error: { step: string; code: string } | null;
  components: {
    kind: ComponentKind;
    ref: string;
    created: boolean;
    skillVersion?: number | null;
  }[];
}

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

/** Confirms a staged import; `deployExtension` also installs and enables the plugin's extension. */
export const confirmPluginImport = (
  stagingId: string,
  body: { reviewHash: string; deployExtension: boolean },
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

export const addMarketplace = (body: { name: string; url: string; token?: string }) =>
  apiFetch<Marketplace>(marketplaces, post(body));

export const updateMarketplace = (
  id: string,
  body: { name?: string; url?: string; enabled?: boolean; token?: string | null },
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
