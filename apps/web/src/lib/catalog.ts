import type { AdminExtension, PackageWarning } from "./admin-extensions";
import { ApiClientError, apiFetch, CSRF_HEADER, ensureSession } from "./api";
import type { PermissionGroup, PermissionItem } from "./extensions";

/**
 * The enterprise catalog (kernel `catalog/*.controller.ts`):
 * - deployment level (enterprise admins): `/api/v1/admin/catalog/*` items, import (file / npm), the
 *   one-review plugin import (prepare -> confirm), policy, install on the deployment, deployment-stage
 *   requests; `/api/v1/admin/marketplaces/*` marketplaces, browsing their entries, importing from them;
 * - org side: `/api/v1/orgs/:orgId/catalog*` browse, detail, request, install; `plugin-installs` the
 *   installed plugins and uninstall; the inbox's `catalog_request` is decided by org admins with
 *   `catalog-requests/:id/decide`.
 * Item icons come only from kernel routes (nosniff + CSP sandbox); the web shows them only in `<img>`,
 * never inline.
 */

export const PACKAGE_KINDS = ["plugin", "connector-template", "skill", "app"] as const;
export type PackageKind = (typeof PACKAGE_KINDS)[number];

export const CATALOG_POLICIES = ["allow", "needs_approval", "disabled"] as const;
export type CatalogPolicy = (typeof CATALOG_POLICIES)[number];

export interface LocalizedName {
  zh: string;
  en: string;
}

/** A catalog item, admin view (kernel `CatalogItemView`). */
export interface CatalogItem {
  id: string;
  kind: PackageKind;
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
  /** 从清单引入时的来源清单 id（`official` 或企业清单 id），否则 null。 */
  marketplaceId: string | null;
  /** 来源清单里最高的兼容版本（不是从清单引入或来源停用为 null）。 */
  latestMarketplaceVersion: string | null;
  /** 清单里有比已引入的更新的兼容版本（「有新版本」）。 */
  newerInMarketplace: boolean;
  updatedAt: string;
}

export interface CatalogItemVersion {
  version: string;
  source: "file" | "npm" | "marketplace";
  sourceRef: string;
  integrity: string | null;
  size: number;
  importedAt: string;
}

export interface CatalogItemDetail {
  item: CatalogItem & { packageName: string; deletedAt: string | null };
  versions: CatalogItemVersion[];
  /** 最新版本有图标（经内核路由以 `<img>` 显示）。 */
  hasIcon: boolean;
}

/** One extension in a plugin review (kernel `PluginReviewExtension`). */
export interface PluginReviewExtension {
  name: string;
  npm: string;
  range: string;
  lockVersion: string;
  sha256: string;
  action: "install" | "upgrade" | "keep";
  currentVersion: string | null;
  optional: boolean;
  permissions: PermissionGroup[];
  added: string[];
  addedItems: PermissionItem[];
  removed: string[];
  warnings: PackageWarning[];
  sensitive: boolean;
}

/** The one review of a plugin (kernel `PluginReview`). */
export interface PluginReview {
  name: string;
  version: string;
  publisher: string;
  description: string;
  plugins: PluginReviewExtension[];
  connectorTemplates: {
    id: string;
    plugin: string;
    connector: string;
    endpoint: Record<string, unknown>;
    auth: Record<string, unknown>;
    editableEndpoint: string[];
    endpointChecked: boolean;
  }[];
  skills: { name: string; description: string; path: string; files: number }[];
  sensitive: boolean;
  reviewHash: string;
}

/** 清单权限摘要与包算出的不一致（只警告）。 */
export type PermissionsMismatch = { missing: string[]; extra: string[] } | null;

export interface PluginPrepared {
  stagingId: string;
  review: PluginReview;
  permissionsMismatch?: PermissionsMismatch;
}

export interface PluginDeployResult {
  name: string;
  action: "install" | "upgrade";
  version: string;
  sha256: string;
  result: "installed" | "enabled" | "failed";
  code?: string;
  message?: string;
}

export interface PluginConfirmResult {
  item: CatalogItem;
  deploy: PluginDeployResult[] | null;
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

/** A marketplace entry (kernel `MarketplaceEntryView`). */
export interface MarketplaceEntry {
  sourceId: string;
  sourceName: string;
  kind: PackageKind;
  name: string;
  npm: string;
  publisher: string;
  summary: { en: string; zh?: string };
  permissions: { keys: string[]; sensitive: string[] } | null;
  versions: { version: string; compatible: boolean; minKernel?: string; minSdk?: string }[];
  adopted: { itemId: string; versions: string[] } | null;
  newerAvailable: boolean;
}

/** A catalog request (kernel `CatalogRequestView`). */
export interface CatalogRequest {
  id: string;
  orgId: string;
  orgName: string;
  item: { id: string; kind: PackageKind; name: string; displayName: LocalizedName | null };
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
  installed: {
    connectorId?: string;
    skillId?: string;
    plugin?: string;
    pluginInstallId?: string;
    version: string;
  } | null;
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

export interface OrgCatalogDetail {
  item: OrgCatalogItem;
  hasIcon: boolean;
  templates: OrgCatalogTemplate[];
  plugins: { name: string; range: string; optional: boolean }[];
  skills: string[];
}

/** 组织安装时一个连接器填的部分。 */
export interface ConnectorInstallInput {
  name?: string;
  slug?: string;
  endpoint?: Record<string, unknown>;
  credential?: Record<string, unknown>;
  client?: { clientId: string; clientSecret?: string };
}

export interface OrgInstallBody {
  version?: string;
  connector?: ConnectorInstallInput;
  plugin?: {
    connectors: Record<string, ConnectorInstallInput>;
    extensionConfigs?: Record<string, Record<string, unknown>>;
  };
}

/** 安装结果：`installed`（201）或已建申请（202，需企业管理员批准）。 */
export type OrgInstallResult =
  | {
      installed: {
        kind: PackageKind;
        itemId: string;
        version: string;
        connectorId?: string;
        pluginInstallId?: string;
      };
    }
  | { request: CatalogRequest };

export type ComponentKind = "extension" | "connector" | "skill";

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
  components: { kind: ComponentKind; ref: string; created: boolean }[];
}

export const KEPT_REASONS = [
  "pre_existing",
  "used_by_agents",
  "used_by_other_install",
  "used_by_connectors",
  "used_by_plugins",
] as const;
export type KeptReason = (typeof KEPT_REASONS)[number];

/** 卸载报告（内核 `UninstallReport`）。 */
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
const npmBody = (pkg: string, version: string) => ({
  package: pkg,
  ...(version !== "" && { version }),
});

// ---- 部署级：目录条目 ----

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

export const installItemToDeployment = (id: string, version: string) =>
  apiFetch<AdminExtension>(`${admin}/items/${enc(id)}/install-deployment`, post({ version }));

export const importCatalogNpm = (pkg: string, version: string) =>
  apiFetch<CatalogItem>(`${admin}/import/npm`, post(npmBody(pkg, version)));

export const preparePluginNpm = (pkg: string, version: string) =>
  apiFetch<PluginPrepared>(`${admin}/plugins/prepare/npm`, post(npmBody(pkg, version)));

export const confirmPlugin = (
  stagingId: string,
  body: { reviewHash: string; deployPlugins: boolean },
) => apiFetch<PluginConfirmResult>(`${admin}/plugins/${enc(stagingId)}/confirm`, post(body));

/** 后台条目图标地址（只用作 `<img>` 的地址）。 */
export const adminIconUrl = (id: string) => `${admin}/items/${enc(id)}/icon`;

/**
 * Uploads a catalog package (raw bytes, streamed by the kernel): target `item` goes to `import/file`
 * (extension / connector template / skill), `app` to `plugins/prepare/file` (returns the one
 * review). Checks the session first (the proxy streams the body through, and a stream cannot be
 * replayed).
 */
export async function uploadCatalogPackage<T>(file: Blob, target: "item" | "app"): Promise<T> {
  await ensureSession();
  const res = await fetch(
    target === "app" ? `${admin}/plugins/prepare/file` : `${admin}/import/file`,
    {
      method: "POST",
      credentials: "same-origin",
      headers: { [CSRF_HEADER]: "1", "content-type": "application/octet-stream" },
      body: file,
    },
  ).catch((e: unknown) => {
    throw new ApiClientError(0, "network", e instanceof Error ? e.message : String(e));
  });
  const text = await res.text();
  if (!res.ok) {
    try {
      const err = (JSON.parse(text) as { error?: { code?: string; message?: string } }).error;
      if (typeof err?.code === "string") {
        throw new ApiClientError(res.status, err.code, err.message ?? err.code);
      }
    } catch (e) {
      if (e instanceof ApiClientError) throw e;
    }
    throw new ApiClientError(res.status, "http_error", `HTTP ${res.status}`);
  }
  return JSON.parse(text) as T;
}

// ---- 部署级：申请 ----

export const listDeploymentRequests = () =>
  apiFetch<{ requests: CatalogRequest[] }>(`${admin}/requests?status=pending`);

export const decideDeploymentRequest = (id: string, decision: "approve" | "reject") =>
  apiFetch<{ request: CatalogRequest }>(`${admin}/requests/${enc(id)}/decide`, post({ decision }));

// ---- 部署级：清单 ----

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

export const listMarketplaceEntries = (
  q: { sourceId?: string; kind?: PackageKind; q?: string } = {},
) => {
  const params = new URLSearchParams();
  if (q.sourceId) params.set("sourceId", q.sourceId);
  if (q.kind) params.set("kind", q.kind);
  if (q.q) params.set("q", q.q);
  const qs = params.toString();
  return apiFetch<{ items: MarketplaceEntry[]; truncated?: boolean }>(
    `${marketplaces}/entries${qs === "" ? "" : `?${qs}`}`,
  );
};

/** 从清单引入：插件 / 模板 / 技能返回条目；应用返回暂存 id 与审阅（再去审阅页确认）。 */
export const importMarketplaceEntry = (
  e: Pick<MarketplaceEntry, "sourceId" | "kind" | "name">,
  version: string,
) =>
  apiFetch<
    | { item: CatalogItem; permissionsMismatch: PermissionsMismatch }
    | { stagingId: string; review: PluginReview; permissionsMismatch: PermissionsMismatch }
  >(
    `${marketplaces}/${enc(e.sourceId)}/entries/${enc(e.kind)}/${enc(e.name)}/import`,
    post({ version }),
  );

// ---- 组织侧 ----

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

/** 审阅里是否有敏感项（任一插件敏感或有迁移警告）。 */
export const pluginReviewSensitive = (r: PluginReview): boolean =>
  r.sensitive || r.plugins.some((p) => p.sensitive || p.warnings.length > 0);
