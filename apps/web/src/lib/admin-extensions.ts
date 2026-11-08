import { apiFetch } from "./api";
import type { LocalizedName, PluginScope } from "./catalog";
import type { PermissionGroup, PermissionItem } from "./extensions";
import type { ConfigIssue, JsonSchema } from "./json-schema";

/**
 * Deployment-level extension management (`/api/v1/admin/extensions/*`, kernel
 * `admin/extensions.controller.ts`, super admins): list and detail, upload / npm import
 * (returns the review), install / approve / enable / disable / uninstall, deployment config.
 * Writes only set the desired state and return; replicas converge afterwards (the returned status
 * may be `converging`).
 */

/** Deployment-level extension status (kernel `DeploymentExtensionStatus`). */
export const EXTENSION_STATUSES = [
  "enabled",
  "disabled",
  "pending_approval",
  "pending_config",
  "pending_migration",
  "converging",
  "failed",
  "dependency",
  "conflict",
  "legacy_format",
] as const;
export type ExtensionStatus = (typeof EXTENSION_STATUSES)[number];

/**
 * Where the kernel loads an extension from: the startup config `extensions` list, or an install
 * record (kernel `ExtensionSource`).
 */
export type ExtensionLoadSource = "config" | "install";

/** Where an install record's package came from (kernel `AdminExtensionView.installSource`). */
export type InstallSource = "npm" | "file" | "catalog" | "bootstrap";

/**
 * The source the console shows and filters by: bootstrap (installed by the deployment's bootstrap
 * step from the plugins the core image carries), the startup config, or installed (admin console,
 * CLI, catalog).
 */
export const EXTENSION_SOURCES = ["bootstrap", "config", "install"] as const;
export type ExtensionSource = (typeof EXTENSION_SOURCES)[number];

/** {@link ExtensionSource} of an extension. */
export const displaySource = (
  p: Pick<AdminExtension, "source" | "installSource">,
): ExtensionSource =>
  p.source === "install" && p.installSource === "bootstrap" ? "bootstrap" : p.source;

export interface ExtensionReplica {
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

/** One row of the admin extension list (kernel `AdminExtensionView`). */
export interface AdminExtension {
  name: string;
  /** The extension's display name; null when it has none (show the id). */
  displayName?: LocalizedName | null;
  version: string;
  source: ExtensionLoadSource;
  /** An install record's package source; null for a config-declared extension. */
  installSource: InstallSource | null;
  /**
   * A required bootstrap plugin: enabled in every organization, cannot be disabled or uninstalled
   * (a super admin may upgrade it).
   */
  required: boolean;
  /** Who the plugin shipping the extension is offered to (`all` for builtin); null without a catalog item. */
  scope?: PluginScope | null;
  /** Orgs it is on in. */
  enabledOrgs?: number;
  /** Shipped with the deployment (a required bootstrap plugin). */
  builtin?: boolean;
  sha256: string | null;
  status: ExtensionStatus;
  desired: { version: string; sha256: string; state: "enabled" | "disabled" } | null;
  replicas: ExtensionReplica[];
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
    source: "cli" | "auto" | "web" | "bootstrap";
  } | null;
  configurable: boolean;
  configValid: boolean;
  /**
   * Orgs with the extension on whose effective config is not valid because the platform left an
   * overridable field empty (spec A §5.4a); absent when none.
   */
  orgsNeedingConfig?: number;
  removable: boolean;
  /** 包读不到时的说明（此时 status 为 failed、权限为空）。 */
  error?: string;
  /**
   * Only with status `conflict`: the single-provider extension point (`sandbox@2`) and the other
   * extensions providing it; disabling them loads this one, no restart.
   */
  conflict?: {
    extensionPoint: string;
    providers: { name: string; displayName: LocalizedName | null }[];
  };
}

/** 迁移 SQL 的审阅警告（敏感，不拒绝）。 */
export interface PackageWarning {
  kind: "destructive_migration" | "dynamic_sql" | "foreign_schema";
  sensitive: true;
  file: string;
  line: number;
  statement: string;
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
  /**
   * Only on a secret record some `x-ui.secrets[].path` names: the record's keys that are set (item
   * names, never values); saved per key through `secretEntries`.
   */
  keys?: string[];
  /** What orgs may do with the field: see it (`readonly`) or bring their own (`override`); absent = hidden. */
  org?: "readonly" | "override";
}

/** One operation on a secret record drawn per item (kernel `SecretEntry`). */
export interface SecretEntry {
  path: string;
  key: string;
  /** A string sets the key, `null` removes it. */
  value?: string | null;
  /** Moves the value at this key to `key` first. */
  renameFrom?: string;
}

/** `GET / PUT /admin/extensions/:name/config` (kernel `DeploymentConfigView`). */
export interface DeploymentConfigView {
  plugin: string;
  /** The plugin's display name; null when it has none. */
  displayName?: LocalizedName | null;
  version: string;
  configurable: boolean;
  fields: DeploymentConfigField[];
  schema: JsonSchema | null;
  valid: boolean;
  /** false：本副本没加载这个插件，`valid` 不是校验结果（加载时才校验）。 */
  validated: boolean;
  issues: ConfigIssue[];
  /** The required overridable fields the platform left empty: each org must configure them itself. */
  orgMustConfigure?: string[];
}

/** One org copy of the overridable config (kernel `OrgOverrideSummary`). */
export interface OrgOverrideSummary {
  orgId: string;
  orgName: string;
  createdAt: string;
  /** The overridable non-secret fields whose copy value differs from the platform's. */
  differing: string[];
  secrets: { path: string; set: boolean }[];
}

const base = "/api/v1/admin/extensions";
const one = (name: string) => `${base}/${encodeURIComponent(name)}`;
const post = (body?: unknown): RequestInit => ({
  method: "POST",
  ...(body !== undefined && { body: JSON.stringify(body) }),
});

/** 全部插件；`drainSeconds`：停用 / 升级时在途工具调用最多等待的秒数。 */
/** A single extension (polled while the detail page converges); 409 `extension.package_unavailable` when the package cannot be read. */
export const getAdminExtension = (name: string) => apiFetch<AdminExtension>(one(name));

export const listAdminExtensions = () =>
  apiFetch<{ extensions: AdminExtension[]; drainSeconds: number }>(base);

/** 批准权限；安装记录传审阅时的 sha256，配置声明的插件传 null。 */
export const approveExtension = (
  name: string,
  body: { sha256: string | null; reviewHash: string },
) => apiFetch<AdminExtension>(`${one(name)}/approve`, post(body));

export const enableExtension = (name: string) =>
  apiFetch<AdminExtension>(`${one(name)}/enable`, post());
export const disableExtension = (name: string) =>
  apiFetch<AdminExtension>(`${one(name)}/disable`, post());
export const uninstallExtension = (name: string) => apiFetch<void>(one(name), { method: "DELETE" });

export const getExtensionConfig = (name: string) =>
  apiFetch<DeploymentConfigView>(`${one(name)}/config`);

/** The orgs holding a copy of the extension's overridable config (read only). */
export const listExtensionOrgOverrides = (name: string) =>
  apiFetch<{ overrides: OrgOverrideSummary[] }>(`${one(name)}/org-overrides`);

/**
 * 保存部署级配置：键为字段点路径，`null` 清除，没给的字段不变；`secretEntries` 改带提示的密钥 record 的单个键。
 */
export const putExtensionConfig = (
  name: string,
  values: Record<string, unknown>,
  secretEntries: SecretEntry[] = [],
) =>
  apiFetch<DeploymentConfigView>(`${one(name)}/config`, {
    method: "PUT",
    body: JSON.stringify({ values, ...(secretEntries.length > 0 && { secretEntries }) }),
  });

/**
 * Clears the deployment config saved in the admin console (values and secrets); the startup
 * config's fields stay. Answers the config as it is now.
 */
export const clearExtensionConfig = (name: string) =>
  apiFetch<DeploymentConfigView>(`${one(name)}/config`, { method: "DELETE" });

/**
 * Whether the replicas agree: at least one reported, and every one has the same version and state
 * with none failed (`consistent`); `inSync` counts the ones that agree (「副本一致 2/2」,
 * 「副本不一致 1/2」); `failed` lists the failed replicas.
 */
export function replicaSummary(p: Pick<AdminExtension, "replicas">): {
  total: number;
  /** Replicas that agree: not failed, same version and state as the first one that is not. */
  inSync: number;
  consistent: boolean;
  failed: ExtensionReplica[];
} {
  const failed = p.replicas.filter((r) => r.state === "failed");
  const first = p.replicas.find((r) => r.state !== "failed");
  const inSync =
    first === undefined
      ? 0
      : p.replicas.filter(
          (r) => r.state !== "failed" && r.version === first.version && r.state === first.state,
        ).length;
  const total = p.replicas.length;
  return { total, inSync, consistent: total > 0 && inSync === total, failed };
}

/** 审阅结果是否含敏感项（敏感分组或迁移警告）：确认安装 / 批准前须勾选「我已了解敏感项」。 */
export const reviewSensitive = (r: {
  permissions: PermissionGroup[];
  warnings: PackageWarning[];
}): boolean => r.permissions.some((g) => g.sensitive) || r.warnings.length > 0;
