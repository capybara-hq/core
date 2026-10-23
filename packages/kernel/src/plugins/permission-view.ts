import { createHash } from "node:crypto";
import { pluginSchemaName } from "../ctx/create-ctx.js";
import { isDestructiveSql, splitSqlStatements } from "../db/sql-statements.js";
import { type PermissionSet, permissionKeys, WARNINGS_KEY_PREFIX } from "./permission-set.js";
import type { PluginSource } from "./sources.js";

/**
 * 审阅摘要：`sha256(permissionKeys(set).join("\n"))` 的前 16 位十六进制；有迁移警告时再并入警告的摘要
 * （种类、文件、行与语句），没有警告时与只看权限的摘要相同。批准时调用方回传它，与此刻重新计算的不一致
 * （审阅后权限或警告变了）就拒绝批准（`plugin.approval_stale`）。
 */
export function reviewHash(set: PermissionSet, warnings: readonly PackageWarning[] = []): string {
  const h = createHash("sha256").update(permissionKeys(set).join("\n"));
  if (warnings.length > 0) {
    h.update("\n--warnings--\n");
    h.update(warnings.map((w) => `${w.kind}\t${w.file}:${w.line}\t${w.statement}`).join("\n"));
  }
  return h.digest("hex").slice(0, 16);
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
  /** 与 `items` 一一对应：逐项的敏感标记与原因（界面据此高亮并写原因，不自己判定）。 */
  entries: PermissionItem[];
}

/**
 * 敏感原因码（界面按码翻译）：密钥、公开路由、工具、hook、嵌入应用，以及敏感能力
 * （{@link SENSITIVE_CAPABILITIES}，码为能力名去掉 `@<主版本>`、`-` 换 `_`）。
 */
export type SensitiveReason =
  | "secrets"
  | "public_routes"
  | "tools"
  | "hooks"
  | "ui_embed"
  | "channel"
  | "directory"
  | "identity_source"
  | "sandbox"
  | "object_store"
  | "migration_warnings";

/** 权限清单里的一项（分组里的一项，或 `added` 里的一个权限键）。 */
export interface PermissionItem {
  value: string;
  sensitive: boolean;
  /** 敏感时的原因码。 */
  reason?: SensitiveReason;
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

const CATEGORY_REASON: Partial<Record<Category, SensitiveReason>> = {
  secrets: "secrets",
  publicRoutes: "public_routes",
  tools: "tools",
  hooks: "hooks",
};

/**
 * 某类别里的一项为什么敏感（不敏感返回 undefined；分组清单、`added` 逐项与 CLI 的标记共用这一处）：
 * 密钥、公开路由、工具、hook 总是敏感；「提供」里的 {@link SENSITIVE_CAPABILITIES}；「界面」里的嵌入应用（`embed:<id>`）。
 */
function itemReason(category: Category, item: string): SensitiveReason | undefined {
  // storage 不算敏感：ctx.storage 的键由内核加前缀 `plugins/<插件>/<orgId>/`，插件只能读写自己的前缀
  if (category === "provides") {
    return SENSITIVE_CAPABILITIES.includes(item)
      ? ((item.split("@")[0] as string).replaceAll("-", "_") as SensitiveReason)
      : undefined;
  }
  if (category === "ui") return item.startsWith("embed:") ? "ui_embed" : undefined;
  return ALWAYS_SENSITIVE.has(category) ? CATEGORY_REASON[category] : undefined;
}

const itemOf = (category: Category, value: string): PermissionItem => {
  const reason = itemReason(category, value);
  return reason === undefined ? { value, sensitive: false } : { value, sensitive: true, reason };
};

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
    ["permissions.hooks.policy:", "hooks", "policy:"],
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
  if (key.startsWith(WARNINGS_KEY_PREFIX)) return true;
  const k = keyItem(key);
  return k !== null && itemReason(k.category, k.item) !== undefined;
}

/** 权限键逐项的敏感标记与原因（`added` 用；与 {@link permissionGroups} 同一套规则）。 */
export function permissionKeyItems(keys: string[]): PermissionItem[] {
  return keys.map((value) => {
    // 迁移警告的摘要（Ruling P4）：警告本身见 `warnings`
    if (value.startsWith(WARNINGS_KEY_PREFIX)) {
      return { value, sensitive: true, reason: "migration_warnings" as const };
    }
    const k = keyItem(value);
    if (k === null) return { value, sensitive: false };
    const reason = itemReason(k.category, k.item);
    return reason === undefined ? { value, sensitive: false } : { value, sensitive: true, reason };
  });
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
  const groups: Omit<PermissionGroup, "sensitive" | "entries">[] = [
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
    { category: "hooks", items: [...p.hooks, ...(p.policyHooks ?? []).map((h) => `policy:${h}`)] },
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
    .map((g) => {
      const entries = g.items.map((i) => itemOf(g.category, i));
      return { ...g, sensitive: entries.some((e) => e.sensitive), entries };
    });
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

/**
 * 需要企业管理员处理的状态（后台概览「需要处理的插件」）：待批准、待配置、失败、依赖缺失，以及副本不一致
 * （`converging` 收敛中、`pending_migration` 待迁移）。
 */
export function pluginNeedsAction(status: DeploymentPluginStatus): boolean {
  return status !== "enabled" && status !== "disabled";
}

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
    /** 这一行的版本没加载成、该副本仍在用的旧版本（新版失败 / 待批准时旧版照常）；否则 null。 */
    servingVersion: string | null;
    heartbeatAt: string;
  }[];
  permissions: PermissionGroup[];
  /** 相对已批准快照多出 / 少了的权限键（没有快照时全部算新增；内置插件预先批准，恒为空）。 */
  added: string[];
  /** `added` 逐项的敏感标记与原因。 */
  addedItems: PermissionItem[];
  removed: string[];
  /** 见 {@link reviewHash}：网页批准时回传。 */
  reviewHash: string;
  /** 任一权限分组敏感（与 `permissions[].sensitive` 一致，界面据此高亮）。 */
  sensitive: boolean;
  /**
   * 安装记录包里迁移 SQL 的审阅警告（与上传时的 `PackageReview.warnings` 相同；内置 / 配置声明为空）。
   * 批准前界面同样高亮并要求确认。
   */
  warnings: PackageWarning[];
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

/**
 * 迁移 SQL 的审阅警告：破坏性语句（`destructive_migration`）、内容不做静态检查的 `DO` 块（`dynamic_sql`，
 * 块里可以执行任意语句），以及写到插件自己 schema 之外或改权限 / 角色 / 事务的语句（`foreign_schema`，
 * 见 {@link isForeignSchemaSql}）。都标敏感，不拒绝。
 */
export function migrationWarnings(
  files: { file: string; sql: string }[],
  plugin: string,
): PackageWarning[] {
  const own = pluginSchemaName(plugin);
  return files.flatMap((m) =>
    splitSqlStatements(m.sql).flatMap((st): PackageWarning[] => {
      const base = { sensitive: true as const, file: m.file, line: st.line, statement: st.text };
      if (/^DO\b/i.test(st.text)) return [{ kind: "dynamic_sql", ...base }];
      if (isForeignSchemaSql(withQuoted(st), own)) return [{ kind: "foreign_schema", ...base }];
      if (isDestructiveSql(st.text)) return [{ kind: "destructive_migration", ...base }];
      return [];
    }),
  );
}

/**
 * 迁移警告的摘要（种类、文件与语句，不含行号：只挪行不算变化）：sha256 前 16 位十六进制；没有警告时为空串。
 * 记进安装记录包的权限集合（`warningsDigest`，Ruling P4）：权限不变、警告变了（如新增 `GRANT`）同样要重新批准。
 */
export function warningsDigest(warnings: readonly PackageWarning[]): string {
  if (warnings.length === 0) return "";
  return createHash("sha256")
    .update(warnings.map((w) => `${w.kind}\t${w.file}\t${w.statement}`).join("\n"))
    .digest("hex")
    .slice(0, 16);
}

const IDENT_RE = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)`;
const TARGET_RE = String.raw`(${IDENT_RE}(?:\s*\.\s*${IDENT_RE})?)`;
/** 写语句的目标对象（建 / 改 / 删表、索引、视图等，以及 INSERT / UPDATE / DELETE / TRUNCATE / MERGE / COPY 的表）。 */
const WRITE_TARGETS: RegExp[] = [
  new RegExp(String.raw`^INSERT\s+INTO\s+${TARGET_RE}`, "i"),
  new RegExp(String.raw`^UPDATE\s+(?:ONLY\s+)?${TARGET_RE}`, "i"),
  new RegExp(String.raw`^DELETE\s+FROM\s+(?:ONLY\s+)?${TARGET_RE}`, "i"),
  new RegExp(String.raw`^TRUNCATE\s+(?:TABLE\s+)?(?:ONLY\s+)?${TARGET_RE}`, "i"),
  new RegExp(String.raw`^MERGE\s+INTO\s+${TARGET_RE}`, "i"),
  new RegExp(String.raw`^COPY\s+${TARGET_RE}`, "i"),
  new RegExp(
    String.raw`^(?:CREATE|ALTER|DROP)\s+(?:OR\s+REPLACE\s+)?(?:(?:GLOBAL|LOCAL)\s+)?(?:(?:TEMP|TEMPORARY|UNLOGGED|MATERIALIZED|UNIQUE|FOREIGN)\s+)?(?:TABLE|INDEX|VIEW|SEQUENCE|TYPE|DOMAIN)\s+(?:CONCURRENTLY\s+)?(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(?:ONLY\s+)?${TARGET_RE}`,
    "i",
  ),
  // CREATE INDEX … ON <表>
  new RegExp(String.raw`^CREATE\s+(?:UNIQUE\s+)?INDEX\b.*?\bON\s+(?:ONLY\s+)?${TARGET_RE}`, "i"),
];

/** 标识符规范化：带引号的去引号（`""` 还原），不带引号的转小写。 */
const normIdent = (s: string) =>
  s.startsWith('"') ? s.slice(1, -1).replaceAll('""', '"') : s.toLowerCase();

/** 写语句的目标里有带 schema、且不是 `own` 的。 */
function writesOtherSchema(t: string, own: string): boolean {
  for (const re of WRITE_TARGETS) {
    const m = re.exec(t);
    if (!m) continue;
    const parts = (m[1] as string).match(new RegExp(IDENT_RE, "g")) ?? [];
    if (parts.length === 2 && normIdent(parts[0] as string) !== own) return true;
  }
  return false;
}

/** 把语句 `text` 里抹掉的双引号标识符填回去（`"capybara".x` 这类引用才看得见）。 */
function withQuoted(st: { text: string; quoted: string[] }): string {
  let k = 0;
  return st.text.replace(/""/g, () => `"${st.quoted[k++] ?? ""}"`);
}

/**
 * 语句是否越出插件自己的 schema（`own`，即 `plugin_<name>`；够用即可，不是 SQL 解析器）：引用内核 schema
 * `capybara`（`capybara.x` / `"capybara".x`）、写到别的 schema 的对象（`other.x`）、`GRANT` / `REVOKE`、
 * `CREATE` / `ALTER` / `DROP ROLE|USER|GROUP`、`ALTER DEFAULT PRIVILEGES`、`ALTER … OWNER TO`、
 * `SET ROLE` / `SET SESSION AUTHORIZATION` / `SET search_path`、`CREATE SCHEMA`、`CREATE EXTENSION`、
 * `CREATE [OR REPLACE] FUNCTION|PROCEDURE|TRIGGER|EVENT TRIGGER`、`COPY … PROGRAM`，以及事务控制
 * `COMMIT` / `ROLLBACK` / `BEGIN` / `START TRANSACTION` / `END`（迁移器把每个文件放在一个事务里）。
 */
export function isForeignSchemaSql(t: string, own: string): boolean {
  return (
    /(?:^|[^\w$"])"?capybara"?\s*\./i.test(t) ||
    writesOtherSchema(t, own) ||
    /^ALTER\b.*\bOWNER\s+TO\b/i.test(t) ||
    /^SET\s+(?:SESSION\s+|LOCAL\s+)?search_path\b/i.test(t) ||
    /^CREATE\s+(?:SCHEMA|EXTENSION)\b/i.test(t) ||
    /^COPY\b.*\bPROGRAM\b/i.test(t) ||
    /^(?:GRANT|REVOKE)\b/i.test(t) ||
    /^(?:CREATE|ALTER|DROP)\s+(?:ROLE|USER|GROUP)\b/i.test(t) ||
    /^ALTER\s+DEFAULT\s+PRIVILEGES\b/i.test(t) ||
    /^SET\s+(?:SESSION\s+|LOCAL\s+)?(?:ROLE|SESSION\s+AUTHORIZATION)\b/i.test(t) ||
    /^CREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?(?:FUNCTION|PROCEDURE|TRIGGER|EVENT\s+TRIGGER)\b/i.test(
      t,
    ) ||
    /^(?:COMMIT|ROLLBACK|BEGIN|START\s+TRANSACTION|END|ABORT)\b/i.test(t)
  );
}

/** {@link PackageReview.warnings} 的一项。 */
export interface PackageWarning {
  /**
   * `dynamic_sql`：`DO` 块，块内语句没有检查；`foreign_schema`：写到插件自己 schema 之外、改权限 / 角色、
   * 建函数 / 触发器或控制事务（{@link isForeignSchemaSql}）。
   */
  kind: "destructive_migration" | "dynamic_sql" | "foreign_schema";
  sensitive: true;
  /** 迁移文件名（`capybara.migrations` 目录下）。 */
  file: string;
  line: number;
  /** 语句（压成一行，字符串字面量已抹掉）。 */
  statement: string;
}
