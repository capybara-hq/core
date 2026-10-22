import { ApiClientError, apiFetch, CSRF_HEADER, ensureSession } from "./api";
import type { JsonSchema } from "./json-schema";
import type { PermissionGroup } from "./plugins";

/**
 * 部署级插件管理（`/api/v1/admin/plugins/*`，内核 `admin/plugins.controller.ts`，企业管理员）：列表与详情、
 * 上传 / npm 导入（返回审阅结果）、安装 / 批准 / 启用 / 停用 / 卸载、部署级配置。
 * 写操作只写期望状态就返回，各副本随后收敛（返回的状态可能是 `converging`）。
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
  reason: string | null;
  detail: string | null;
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
  removed: string[];
  reviewHash: string;
  sensitive: boolean;
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
  kind: "destructive_migration" | "dynamic_sql";
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

/** `GET / PUT /admin/plugins/:name/config`（内核 `DeploymentConfigView`）。 */
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

const base = "/api/v1/admin/plugins";
const one = (name: string) => `${base}/${encodeURIComponent(name)}`;
const post = (body?: unknown): RequestInit => ({
  method: "POST",
  ...(body !== undefined && { body: JSON.stringify(body) }),
});

/** 全部插件；`drainSeconds`：停用 / 升级时在途工具调用最多等待的秒数。 */
export const listAdminPlugins = () =>
  apiFetch<{ plugins: AdminPlugin[]; drainSeconds: number }>(base);

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

/**
 * 上传插件包（tgz 原始字节）并取回审阅结果。用 XMLHttpRequest 取得上传进度（fetch 没有）；`signal` 中止时
 * 抛 AbortError。代理对这个路由流式透传请求体，流无法重放，所以上传前先确认登录有效（必要时刷新一次）。
 */
export async function uploadPluginPackage(
  file: Blob,
  opts: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {},
): Promise<PackageReview> {
  await ensureSession();
  opts.signal?.throwIfAborted();
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

/** 敏感的能力（与内核 `SENSITIVE_CAPABILITIES` 一致，只用于逐项高亮与写明原因）。 */
export const SENSITIVE_CAPABILITIES = [
  "channel@1",
  "directory@1",
  "identity-source@1",
  "sandbox@1",
  "object-store@1",
] as const;

/** 总是敏感的类别（与内核 `permission-view.ts` 一致）。 */
const ALWAYS_SENSITIVE = new Set(["secrets", "publicRoutes", "tools", "hooks"]);

/** 分组里的一项是否敏感（展示用：内核只给分组级标记，逐项规则与内核一致）。 */
export function itemSensitive(category: string, item: string): boolean {
  if (category === "provides") return (SENSITIVE_CAPABILITIES as readonly string[]).includes(item);
  if (category === "ui") return item.startsWith("embed:");
  return ALWAYS_SENSITIVE.has(category);
}

/** 审阅结果是否含敏感项（敏感分组或迁移警告）：确认安装 / 批准前须勾选「我已了解敏感项」。 */
export const reviewSensitive = (r: {
  permissions: PermissionGroup[];
  warnings?: PackageWarning[];
}): boolean => r.permissions.some((g) => g.sensitive) || (r.warnings?.length ?? 0) > 0;
