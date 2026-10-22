import { createHash } from "node:crypto";
import { type PermissionSet, permissionKeys } from "./permission-set.js";

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
 * 敏感的能力：`channel@1` 收到组织在 IM 里的对话内容（Ruling A33）、`directory@1` 能把人加进组织（并为其建账号、
 * 建身份）、`identity-source@1` 决定谁能登录成哪个账号。插件提供其中任何一个时，「提供」一组标为敏感。
 */
export const SENSITIVE_CAPABILITIES: readonly string[] = [
  "channel@1",
  "directory@1",
  "identity-source@1",
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
