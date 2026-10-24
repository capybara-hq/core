import { ApiClientError, apiFetch, CSRF_HEADER, ensureSession } from "./api";
import type { PermissionGroup, PermissionItem } from "./extensions";
import type { JsonSchema } from "./json-schema";

/**
 * Deployment-level extension management (`/api/v1/admin/extensions/*`, kernel
 * `admin/extensions.controller.ts`, enterprise admins): list and detail, upload / npm import
 * (returns the review), install / approve / enable / disable / uninstall, deployment config.
 * Writes only set the desired state and return; replicas converge afterwards (the returned status
 * may be `converging`).
 */

/** 部署级插件状态（内核 `DeploymentPluginStatus`）。 */
export const PLUGIN_STATUSES = [
  "enabled",
  "disabled",
  "pending_approval",
  "pending_config",
  "pending_migration",
  "converging",
  "failed",
  "dependency",
] as const;
export type PluginStatus = (typeof PLUGIN_STATUSES)[number];

/** 插件来源：内置（随核心镜像）、启动配置的 `plugins` 列表、后台安装。 */
export const PLUGIN_SOURCES = ["builtin", "config", "install"] as const;
export type PluginSource = (typeof PLUGIN_SOURCES)[number];

export interface PluginReplica {
  replicaId: string;
  version: string;
  /** `loaded` / `failed` / `unloaded` / `pending`。 */
  state: string;
  /** 原因码（内核给的，如 `setup_failed`、`approval`）；界面按 `detail.replicaReason.<码>` 翻译。 */
  reason: string | null;
  detail: string | null;
  /** 这一行的版本没加载成、该副本仍在用的旧版本（新版失败 / 待批准时旧版照常）；否则 null。 */
  servingVersion?: string | null;
  heartbeatAt: string;
}

/** 后台插件列表的一项（内核 `AdminPluginView`）。 */
export interface AdminPlugin {
  name: string;
  version: string;
  source: PluginSource;
  sha256: string | null;
  status: PluginStatus;
  desired: { version: string; sha256: string; state: "enabled" | "disabled" } | null;
  replicas: PluginReplica[];
  permissions: PermissionGroup[];
  added: string[];
  /** `added` 逐项的敏感标记与原因码（内核判定）。 */
  addedItems: PermissionItem[];
  removed: string[];
  reviewHash: string;
  sensitive: boolean;
  /** 安装记录包里迁移 SQL 的审阅警告（批准前同样要确认）。 */
  warnings: PackageWarning[];
  snapshot: {
    version: string;
    approvedAt: string;
    approvedBy: string | null;
    source: "cli" | "auto" | "web";
  } | null;
  configurable: boolean;
  configValid: boolean;
  removable: boolean;
  /** 包读不到时的说明（此时 status 为 failed、权限为空）。 */
  error?: string;
}

/** 迁移 SQL 的审阅警告（敏感，不拒绝）。 */
export interface PackageWarning {
  kind: "destructive_migration" | "dynamic_sql" | "foreign_schema";
  sensitive: true;
  file: string;
  line: number;
  statement: string;
}

/** 上传 / npm 导入的审阅结果（内核 `PackageReview`）。 */
export interface PackageReview {
  sha256: string;
  name: string;
  version: string;
  permissions: PermissionGroup[];
  /** 相对该插件当前权限快照新增 / 减少的权限键（没有快照时全部算新增）。 */
  added: string[];
  /** `added` 逐项的敏感标记与原因码（内核判定）。 */
  addedItems: PermissionItem[];
  removed: string[];
  reviewHash: string;
  warnings: PackageWarning[];
}

/** 部署级配置的一个字段（内核 `DeploymentConfigField`）。 */
export interface DeploymentConfigField {
  path: string;
  secret: boolean;
  hot: boolean;
  source: "env" | "file" | "nacos" | "db" | "default" | "unset";
  readonly: boolean;
  value?: unknown;
  set?: boolean;
}

/** `GET / PUT /admin/extensions/:name/config` (kernel `DeploymentConfigView`). */
export interface DeploymentConfigView {
  plugin: string;
  version: string;
  configurable: boolean;
  fields: DeploymentConfigField[];
  schema: JsonSchema | null;
  valid: boolean;
  /** false：本副本没加载这个插件，`valid` 不是校验结果（加载时才校验）。 */
  validated: boolean;
  issues: { path: string; message: string }[];
}

const base = "/api/v1/admin/extensions";
const one = (name: string) => `${base}/${encodeURIComponent(name)}`;
const post = (body?: unknown): RequestInit => ({
  method: "POST",
  ...(body !== undefined && { body: JSON.stringify(body) }),
});

/** 全部插件；`drainSeconds`：停用 / 升级时在途工具调用最多等待的秒数。 */
/** A single extension (polled while the detail page converges); 409 `extension.package_unavailable` when the package cannot be read. */
export const getAdminPlugin = (name: string) => apiFetch<AdminPlugin>(one(name));

export const listAdminPlugins = () =>
  apiFetch<{ extensions: AdminPlugin[]; drainSeconds: number }>(base);

export const ingestNpm = (pkg: string, version?: string) =>
  apiFetch<PackageReview>(
    `${base}/packages/npm`,
    post({ package: pkg, ...(version !== undefined && version !== "" && { version }) }),
  );

export const installPlugin = (name: string, sha256: string) =>
  apiFetch<AdminPlugin>(`${one(name)}/install`, post({ sha256 }));

/** 批准权限；安装记录传审阅时的 sha256，配置声明的插件传 null。 */
export const approvePlugin = (name: string, body: { sha256: string | null; reviewHash: string }) =>
  apiFetch<AdminPlugin>(`${one(name)}/approve`, post(body));

export const enablePlugin = (name: string) => apiFetch<AdminPlugin>(`${one(name)}/enable`, post());
export const disablePlugin = (name: string) =>
  apiFetch<AdminPlugin>(`${one(name)}/disable`, post());
export const uninstallPlugin = (name: string) => apiFetch<void>(one(name), { method: "DELETE" });

export const getPluginConfig = (name: string) =>
  apiFetch<DeploymentConfigView>(`${one(name)}/config`);

/** 保存部署级配置：键为字段点路径，`null` 清除，没给的字段不变。 */
export const putPluginConfig = (name: string, values: Record<string, unknown>) =>
  apiFetch<DeploymentConfigView>(`${one(name)}/config`, {
    method: "PUT",
    body: JSON.stringify({ values }),
  });

function xhrError(xhr: XMLHttpRequest): ApiClientError {
  try {
    const body = JSON.parse(xhr.responseText) as {
      error?: { code?: unknown; message?: unknown; details?: unknown };
    };
    const e = body.error;
    if (typeof e?.code === "string") {
      const raw = Array.isArray(e.details) ? (e.details as unknown[]) : [];
      const details = raw.flatMap((d) => {
        if (typeof d !== "object" || d === null) return [];
        const { path, message } = d as Record<string, unknown>;
        return typeof message === "string"
          ? [{ path: typeof path === "string" ? path : "", message }]
          : [];
      });
      return new ApiClientError(
        xhr.status,
        e.code,
        typeof e.message === "string" ? e.message : e.code,
        details,
        raw,
      );
    }
  } catch {
    // 非 JSON：落到下面的通用错误
  }
  return new ApiClientError(xhr.status, "http_error", `HTTP ${xhr.status}`);
}

/** 上传途中登录过期（客户端错误码，页面提示重新登录，而不是「后端不可用」）。 */
export const UPLOAD_SESSION_EXPIRED = "extension.upload_session_expired";

/**
 * 上传插件包（tgz 原始字节）并取回审阅结果。用 XMLHttpRequest 取得上传进度（fetch 没有）；`signal` 中止时
 * 抛 AbortError。代理对这个路由流式透传请求体，流无法重放：上传前先确认登录有效（必要时刷新一次）；
 * 上传遇到 401，或代理报上游不可达（流式请求体遇上游 401 时 undici 报网络错误）时，再确认一次登录，
 * 登录确实失效则抛 {@link UPLOAD_SESSION_EXPIRED}。
 */
export async function uploadPluginPackage(
  file: Blob,
  opts: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {},
): Promise<PackageReview> {
  await ensureSession();
  opts.signal?.throwIfAborted();
  try {
    return await sendPackage(file, opts);
  } catch (e) {
    if (e instanceof ApiClientError && (e.status === 401 || e.code === "upstream_unavailable")) {
      const expired = await ensureSession().then(
        () => false,
        (err: unknown) => err instanceof ApiClientError && err.code.startsWith("auth."),
      );
      if (expired) throw new ApiClientError(401, UPLOAD_SESSION_EXPIRED, "Session expired");
    }
    throw e;
  }
}

function sendPackage(
  file: Blob,
  opts: { onProgress?: (fraction: number) => void; signal?: AbortSignal },
): Promise<PackageReview> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${base}/packages/file`);
    xhr.withCredentials = true;
    xhr.setRequestHeader(CSRF_HEADER, "1");
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) opts.onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as PackageReview);
        } catch {
          reject(new ApiClientError(xhr.status, "http_error", "Invalid response"));
        }
      } else reject(xhrError(xhr));
    };
    xhr.onerror = () => reject(new ApiClientError(0, "network", "Upload failed"));
    xhr.onabort = () => reject(new DOMException("Upload aborted", "AbortError"));
    opts.signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}

/**
 * 副本是否一致：至少一个副本上报，且全部副本的版本与状态相同、没有失败的。`failed` 为出错（失败）的副本。
 */
export function replicaSummary(p: Pick<AdminPlugin, "replicas">): {
  total: number;
  consistent: boolean;
  failed: PluginReplica[];
} {
  const failed = p.replicas.filter((r) => r.state === "failed");
  const first = p.replicas[0];
  const consistent =
    first !== undefined &&
    failed.length === 0 &&
    p.replicas.every((r) => r.version === first.version && r.state === first.state);
  return { total: p.replicas.length, consistent, failed };
}

/** 审阅结果是否含敏感项（敏感分组或迁移警告）：确认安装 / 批准前须勾选「我已了解敏感项」。 */
export const reviewSensitive = (r: {
  permissions: PermissionGroup[];
  warnings: PackageWarning[];
}): boolean => r.permissions.some((g) => g.sensitive) || r.warnings.length > 0;
