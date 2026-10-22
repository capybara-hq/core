import { createHash } from "node:crypto";
import { type PermissionSet, permissionKeys } from "./permission-set.js";
import type { PluginSource } from "./sources.js";

/**
 * 审阅摘要：`sha256(permissionKeys(set).join("\n"))` 的前 16 位十六进制。批准时调用方回传它，
 * 与此刻重新计算的不一致（审阅后权限变了）就拒绝批准（`plugin.approval_stale`）。
 */
export function reviewHash(set: PermissionSet): string {
  return createHash("sha256").update(permissionKeys(set).join("\n")).digest("hex").slice(0, 16);
}

/** 权限清单展示用的一组：按类别分组，`sensitive` 标出需要管理员特别留意的类别。 */
export interface PermissionGroup {
  category:
    | "provides"
    | "requires"
    | "optional"
    | "config"
    | "tables"
    | "secrets"
    | "storage"
    | "http"
    | "publicRoutes"
    | "tools"
    | "hooks"
    | "models"
    | "network"
    | "ui";
  /**
   * 敏感类别：密钥、公开路由、工具、hook；「提供」一组含 {@link SENSITIVE_CAPABILITIES} 时也算；
   * 「界面」一组含嵌入应用（embed：插件自己的页面放进 iframe）时也算。
   */
  sensitive: boolean;
  items: string[];
}

/**
 * 敏感的能力（D10 + 计划扩展，F-AI）：`sandbox@1` 在部署里执行任意命令、`object-store@1` 保管全部附件与插件包（D10）；
 * `channel@1` 收到组织在 IM 里的对话内容（Ruling A33）、`directory@1` 能把人加进组织（并为其建账号、建身份）、
 * `identity-source@1` 决定谁能登录成哪个账号。插件提供其中任何一个时，「提供」一组标为敏感，
 * 后台插件列表的 `sensitive` 为真，须企业管理员批准。只影响展示，不改权限快照的键。
 */
export const SENSITIVE_CAPABILITIES: readonly string[] = [
  "channel@1",
  "directory@1",
  "identity-source@1",
  "sandbox@1",
  "object-store@1",
];

type Category = PermissionGroup["category"];

/** 总是敏感的类别。 */
const ALWAYS_SENSITIVE: ReadonlySet<Category> = new Set<Category>([
  "secrets",
  "publicRoutes",
  "tools",
  "hooks",
]);

/**
 * 某类别里的一项是否敏感（分组清单与 CLI 的逐项标记共用这一处）：密钥、公开路由、工具、hook 总是敏感；
 * 「提供」里的 {@link SENSITIVE_CAPABILITIES}；「界面」里的嵌入应用（`embed:<id>`）。
 */
function itemSensitive(category: Category, item: string): boolean {
  // storage 不算敏感：ctx.storage 的键由内核加前缀 `plugins/<插件>/<orgId>/`，插件只能读写自己的前缀
  if (category === "provides") return SENSITIVE_CAPABILITIES.includes(item);
  if (category === "ui") return item.startsWith("embed:");
  return ALWAYS_SENSITIVE.has(category);
}

/** 权限键（{@link permissionKeys} 的格式）所属的类别与展示项；不属于敏感判定相关类别的返回 null。 */
function keyItem(key: string): { category: Category; item: string } | null {
  const after = (prefix: string) => (key.startsWith(prefix) ? key.slice(prefix.length) : null);
  if (key === "permissions.secrets") return { category: "secrets", item: "secret store" };
  if (/^config\.(deployment|org)\.secret:/.test(key))
    return { category: "secrets", item: key.slice(key.indexOf(":") + 1) };
  const table: [string, Category, string][] = [
    ["provides:", "provides", ""],
    ["permissions.http.public:", "publicRoutes", ""],
    ["permissions.tools:", "tools", ""],
    ["permissions.hooks:", "hooks", ""],
    ["ui.embed:", "ui", "embed:"],
    ["ui.view:", "ui", "view:"],
  ];
  for (const [prefix, category, itemPrefix] of table) {
    const rest = after(prefix);
    if (rest !== null) return { category, item: `${itemPrefix}${rest}` };
  }
  return null;
}

/**
 * 单个权限键是否敏感（`capybara plugins review / approve` 逐项标 `(sensitive)`）：
 * 与 {@link permissionGroups} 的敏感分组同一套规则。
 */
export function isSensitivePermissionKey(key: string): boolean {
  const k = keyItem(key);
  return k !== null && itemSensitive(k.category, k.item);
}

/** 把权限集合整理成分组清单（固定顺序，空组省略）。纯函数。 */
export function permissionGroups(set: PermissionSet): PermissionGroup[] {
  const p = set.permissions;
  // 旧快照没有 ui（按空处理）
  const ui = p.ui ?? { views: [], embeds: [] };
  const secretFields = [...set.config.deployment, ...set.config.org]
    .filter((f) => f.secret)
    .map((f) => f.path || "<root>");
  const configFields = (["deployment", "org"] as const).flatMap((level) =>
    set.config[level].map((f) => `${level}:${f.path || "<root>"}`),
  );
  const secretItems = [...(p.secrets ? ["secret store"] : []), ...secretFields];
  const groups: Omit<PermissionGroup, "sensitive">[] = [
    {
      category: "provides",
      items: set.provides,
    },
    { category: "requires", items: set.requires },
    { category: "optional", items: set.optional },
    { category: "config", items: configFields },
    { category: "tables", items: set.tables },
    { category: "secrets", items: secretItems },
    { category: "storage", items: p.storage ? ["storage"] : [] },
    {
      category: "http",
      items: p.http.filter((r) => !r.public).map((r) => `${r.method} ${r.path}`),
    },
    {
      category: "publicRoutes",
      items: p.http.filter((r) => r.public).map((r) => `${r.method} ${r.path}`),
    },
    { category: "tools", items: p.tools },
    { category: "hooks", items: p.hooks },
    {
      category: "models",
      items: p.models.map((m) => `${m.purpose} (${m.kind})`),
    },
    { category: "network", items: p.network },
    {
      category: "ui",
      items: [...ui.views.map((v) => `view:${v}`), ...ui.embeds.map((e) => `embed:${e}`)],
    },
  ];
  return groups
    .filter((g) => g.items.length > 0)
    .map((g) => ({ ...g, sensitive: g.items.some((i) => itemSensitive(g.category, i)) }));
}

/**
 * 部署级插件状态（后台展示；F-I：副本行存原因，这里推导展示用的状态）。
 * `dependency`：必需能力没有（加载着的）提供方（F-M：排在 `failed` 之后、`pending_approval` 之前）。
 */
export type DeploymentPluginStatus =
  | "enabled"
  | "disabled"
  | "pending_approval"
  | "pending_config"
  | "pending_migration"
  | "converging"
  | "failed"
  | "dependency";

/** 后台插件列表的一项（`GET /api/v1/admin/plugins`）。 */
export interface AdminPluginView {
  name: string;
  version: string;
  source: PluginSource;
  /** 安装记录的包；内置 / 配置声明为 null。 */
  sha256: string | null;
  status: DeploymentPluginStatus;
  /** 安装记录的期望状态；内置 / 配置声明为 null（始终期望启用）。 */
  desired: { version: string; sha256: string; state: "enabled" | "disabled" } | null;
  /** 各副本最近一次上报的加载结果。 */
  replicas: {
    replicaId: string;
    version: string;
    state: string;
    reason: string | null;
    detail: string | null;
    heartbeatAt: string;
  }[];
  permissions: PermissionGroup[];
  /** 相对已批准快照多出 / 少了的权限键（没有快照时全部算新增；内置插件预先批准，恒为空）。 */
  added: string[];
  removed: string[];
  /** 见 {@link reviewHash}：网页批准时回传。 */
  reviewHash: string;
  /** 任一权限分组敏感（与 `permissions[].sensitive` 一致，界面据此高亮）。 */
  sensitive: boolean;
  snapshot: {
    version: string;
    approvedAt: string;
    approvedBy: string | null;
    source: "cli" | "auto" | "web";
  } | null;
  /** 有部署级配置字段。 */
  configurable: boolean;
  configValid: boolean;
  /** 能从部署卸载（只有安装记录；卸载前须先停用）。 */
  removable: boolean;
  /** 安装记录的包读不到（字节缺失或损坏、超过现行大小上限）时的说明；此时 status 为 failed、权限为空。 */
  error?: string;
}

/** {@link derivePluginStatus} 的输入。 */
export interface StatusInput {
  source: PluginSource;
  /** 安装记录的期望包与状态；内置 / 配置声明为 null。 */
  desired: { sha256: string; state: "enabled" | "disabled" } | null;
  /** 权限集合未被快照覆盖（F-N：与期望状态无关；内置插件恒为 false）。 */
  pendingApproval: boolean;
  configValid: boolean;
  /** 安装记录的 `migrated_sha`。 */
  migratedSha: string | null;
  /** 计入的副本行（调用方已按心跳筛过）。 */
  replicas: { state: string; reason: string | null; sha256: string | null }[];
}

/**
 * 由期望状态、快照、配置校验、`migrated_sha` 与各副本状态推出部署级状态，优先级：
 * `failed` > `dependency` > `pending_approval` > `pending_config` > `pending_migration` > `converging` > `enabled` / `disabled`。
 * - 安装记录只看目标包（`desired.sha256`）的副本行：旧包的失败不算；
 * - 停用的安装记录不看迁移；仍有副本加载着时为 `converging`；
 * - 内置 / 配置声明始终期望启用。
 */
export function derivePluginStatus(i: StatusInput): DeploymentPluginStatus {
  const target = i.desired?.sha256 ?? null;
  const rows = target === null ? i.replicas : i.replicas.filter((r) => r.sha256 === target);
  if (rows.some((r) => r.state === "failed")) return "failed";
  if (
    rows.some((r) => r.reason === "dependency" && (r.state === "pending" || r.state === "unloaded"))
  )
    return "dependency";
  if (i.pendingApproval) return "pending_approval";
  if (!i.configValid) return "pending_config";
  const wantLoaded = i.desired === null || i.desired.state === "enabled";
  if (!wantLoaded) return i.replicas.some((r) => r.state === "loaded") ? "converging" : "disabled";
  if (i.desired !== null && i.migratedSha !== i.desired.sha256) return "pending_migration";
  if (rows.some((r) => r.state === "pending" && r.reason === "migration"))
    return "pending_migration";
  const done =
    i.replicas.length > 0 &&
    i.replicas.every((r) => r.state === "loaded" && (target === null || r.sha256 === target));
  return done ? "enabled" : "converging";
}
