import type { PermissionSet } from "./permission-set.js";

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
    | "network";
  /** 敏感类别：密钥、公开路由、工具、hook；「提供」一组含 {@link SENSITIVE_CAPABILITIES} 时也算。 */
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

/** 把权限集合整理成分组清单（固定顺序，空组省略）。纯函数。 */
export function permissionGroups(set: PermissionSet): PermissionGroup[] {
  const p = set.permissions;
  const secretFields = [...set.config.deployment, ...set.config.org]
    .filter((f) => f.secret)
    .map((f) => f.path || "<root>");
  const configFields = (["deployment", "org"] as const).flatMap((level) =>
    set.config[level].map((f) => `${level}:${f.path || "<root>"}`),
  );
  const secretItems = [...(p.secrets ? ["secret store"] : []), ...secretFields];
  const groups: PermissionGroup[] = [
    {
      category: "provides",
      sensitive: set.provides.some((c) => SENSITIVE_CAPABILITIES.includes(c)),
      items: set.provides,
    },
    { category: "requires", sensitive: false, items: set.requires },
    { category: "optional", sensitive: false, items: set.optional },
    { category: "config", sensitive: false, items: configFields },
    { category: "tables", sensitive: false, items: set.tables },
    { category: "secrets", sensitive: true, items: secretItems },
    { category: "storage", sensitive: false, items: p.storage ? ["storage"] : [] },
    {
      category: "http",
      sensitive: false,
      items: p.http.filter((r) => !r.public).map((r) => `${r.method} ${r.path}`),
    },
    {
      category: "publicRoutes",
      sensitive: true,
      items: p.http.filter((r) => r.public).map((r) => `${r.method} ${r.path}`),
    },
    { category: "tools", sensitive: true, items: p.tools },
    { category: "hooks", sensitive: true, items: p.hooks },
    {
      category: "models",
      sensitive: false,
      items: p.models.map((m) => `${m.purpose} (${m.kind})`),
    },
    { category: "network", sensitive: false, items: p.network },
  ];
  return groups.filter((g) => g.items.length > 0);
}
