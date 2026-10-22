import { readdir, readFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import type { PluginManifest, PluginPermissions } from "@capybara-hq/plugin-sdk";
import type { core } from "zod";
import { configFields } from "../config/fields.js";
import { pluginSchemaName } from "../ctx/create-ctx.js";
import { MIGRATION_FILE_RE } from "../db/migrator.js";

/** 一个配置字段：点路径（根即叶子时为空串）与是否密钥。 */
export interface PermissionConfigField {
  path: string;
  secret: boolean;
}

/**
 * 插件要用的一切（扩展模型 7.2），规范化后存为已批准快照（`plugin_permission_snapshots.permissions`）。
 * 列表均已排序去重；比较时转成稳定的字符串键（{@link permissionKeys}）。
 */
export interface PermissionSet {
  provides: string[];
  requires: string[];
  optional: string[];
  config: { deployment: PermissionConfigField[]; org: PermissionConfigField[] };
  /** 插件迁移里 `CREATE TABLE` 的表名（插件自己 schema 下的不带前缀）。 */
  tables: string[];
  permissions: {
    secrets: boolean;
    storage: boolean;
    http: { method: string; path: string; public: boolean }[];
    tools: string[];
    hooks: string[];
    /** 模型用途（label 只是展示文案，不参与比较）。 */
    models: { purpose: string; kind: string }[];
    network: string[];
    /**
     * 界面贡献（`permissions.ui`）：`views` 记入快照但不卡加载（升级时自动补进快照）；
     * `embeds` 与其他权限一样卡加载。旧快照没有这一项（按空处理）。
     */
    ui: { views: string[]; embeds: string[] };
  };
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const sortedUnique = (xs: readonly string[] | undefined) => [...new Set(xs ?? [])].sort(cmp);

const IDENT = '(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)';
const CREATE_TABLE_RE = new RegExp(
  String.raw`\bcreate\s+(?:(?:global|local)\s+)?(?:(?:temp|temporary|unlogged)\s+)?table\s+(?:if\s+not\s+exists\s+)?(${IDENT}(?:\s*\.\s*${IDENT})?)`,
  "gi",
);

/** 标识符规范化：带引号的去引号（`""` 还原为 `"`），不带引号的转小写（同 PG 规则）。 */
const normIdent = (s: string) =>
  s.startsWith('"') ? s.slice(1, -1).replaceAll('""', '"') : s.toLowerCase();

/** 把一段 SQL 的 `--` 行注释与 `/* *\/` 块注释去掉（不处理字符串字面量里的注释符：够用即可）。 */
const stripComments = (sql: string) =>
  sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");

/**
 * 解析 SQL 中 `CREATE [TEMP|UNLOGGED] TABLE [IF NOT EXISTS] [schema.]name` 的表名（按出现顺序，不去重）；
 * 其他语句忽略。schema 等于 `ownSchema` 时去掉前缀（与不带前缀等价），其他 schema 保留 `schema.name`。
 *
 * 已知局限（够用即可，不是 SQL 解析器）：
 * - 只看 `CREATE TABLE`：`ALTER TABLE ... RENAME TO` 改名后的新表名不会出现；视图 / 物化视图、
 *   序列、函数等其他建对象语句不计入；
 * - 不带引号的标识符只识别 ASCII（字母、数字、`_`、`$`），不带引号的非 ASCII 表名会被截断或漏掉；
 * - 去注释不理会字符串字面量与 `$$` 块：字符串里的 `--` / `/*` 会被当作注释，字符串里的
 *   `CREATE TABLE x` 文本会被误计。
 */
export function parseCreatedTables(sql: string, ownSchema: string): string[] {
  const out: string[] = [];
  for (const m of stripComments(sql).matchAll(CREATE_TABLE_RE)) {
    const parts = (m[1] as string).match(new RegExp(IDENT, "g")) ?? [];
    const names = parts.map(normIdent);
    if (names.length === 2 && names[0] === ownSchema) out.push(names[1] as string);
    else out.push(names.join("."));
  }
  return out;
}

function fieldsOf(schema: core.$ZodType | undefined): PermissionConfigField[] {
  if (!schema) return [];
  return configFields(schema)
    .map((f) => ({ path: f.path, secret: f.meta?.secret === true }))
    .sort((a, b) => cmp(a.path, b.path));
}

/**
 * 计算插件的权限集合：provides / requires / optional、两级配置字段（路径与是否密钥，经 `configFields` 遍历 zod schema）、
 * 迁移 SQL 中创建的表、清单 `permissions` 各项；全部规范化排序。
 * @param pluginDir 插件模块所在目录（`manifest.migrations` 相对它解析）。
 */
export async function computePermissionSet(
  manifest: PluginManifest,
  pluginDir: string,
): Promise<PermissionSet> {
  const tables: string[] = [];
  if (manifest.migrations) {
    const dir = resolvePath(pluginDir, manifest.migrations);
    const schema = pluginSchemaName(manifest.name);
    try {
      const names = (await readdir(dir)).filter((f) => MIGRATION_FILE_RE.test(f)).sort();
      for (const n of names) {
        tables.push(...parseCreatedTables(await readFile(resolvePath(dir, n), "utf8"), schema));
      }
    } catch (e) {
      throw new Error(
        `plugin ${manifest.name}: cannot read migrations at "${dir}": ${e instanceof Error ? e.message : String(e)}`,
        { cause: e },
      );
    }
  }
  return buildPermissionSet({
    provides: manifest.provides,
    requires: manifest.requires,
    optional: manifest.optional,
    config: {
      deployment: fieldsOf(manifest.config?.deployment),
      org: fieldsOf(manifest.config?.org),
    },
    tables,
    permissions: manifest.permissions,
  });
}

/**
 * 由已提取的各项拼出规范化的权限集合（排序去重）：{@link computePermissionSet}（真实模块）与
 * 插件包的 `permissionSetOfPackage`（静态 manifest + 迁移 SQL）共用，保证两边同形。
 */
export function buildPermissionSet(input: {
  provides: readonly string[];
  requires?: readonly string[] | undefined;
  optional?: readonly string[] | undefined;
  config: { deployment: PermissionConfigField[]; org: PermissionConfigField[] };
  tables: readonly string[];
  permissions?: PluginPermissions | undefined;
}): PermissionSet {
  const p = input.permissions ?? {};
  const byPath = (a: PermissionConfigField, b: PermissionConfigField) => cmp(a.path, b.path);
  return {
    provides: sortedUnique(input.provides),
    requires: sortedUnique(input.requires),
    optional: sortedUnique(input.optional),
    config: {
      deployment: [...input.config.deployment].sort(byPath),
      org: [...input.config.org].sort(byPath),
    },
    tables: sortedUnique(input.tables),
    permissions: {
      secrets: p.secrets === true,
      storage: p.storage === true,
      http: (p.http ?? [])
        .map((r) => ({ method: r.method, path: r.path, public: r.public === true }))
        .sort((a, b) => cmp(`${a.method} ${a.path}`, `${b.method} ${b.path}`)),
      tools: sortedUnique(p.tools),
      hooks: sortedUnique(p.hooks),
      models: (p.models ?? [])
        .map((m) => ({ purpose: m.purpose, kind: m.kind }))
        .sort((a, b) => cmp(a.purpose, b.purpose)),
      network: sortedUnique(p.network),
      ui: { views: sortedUnique(p.ui?.views), embeds: sortedUnique(p.ui?.embeds) },
    },
  };
}

/**
 * 权限集合的稳定字符串键（排序），如 `provides:channel@1`、`config.org.secret:apiKey`、`table:todos`、
 * `permissions.tools:write`、`permissions.http.public:POST /events`、`ui.view:tasks`、`ui.embed:board`。
 * 容忍旧快照缺字段（按空处理），快照格式演进时不会抛错。
 */
export function permissionKeys(set: PermissionSet): string[] {
  const s = (set ?? {}) as Partial<PermissionSet>;
  const p = (s.permissions ?? {}) as Partial<PermissionSet["permissions"]>;
  const keys: string[] = [];
  for (const r of s.provides ?? []) keys.push(`provides:${r}`);
  for (const r of s.requires ?? []) keys.push(`requires:${r}`);
  for (const r of s.optional ?? []) keys.push(`optional:${r}`);
  for (const level of ["deployment", "org"] as const) {
    for (const f of s.config?.[level] ?? []) {
      keys.push(`config.${level}${f.secret ? ".secret" : ""}:${f.path || "<root>"}`);
    }
  }
  for (const t of s.tables ?? []) keys.push(`table:${t}`);
  if (p.secrets) keys.push("permissions.secrets");
  if (p.storage) keys.push("permissions.storage");
  for (const r of p.http ?? []) {
    keys.push(`permissions.http${r.public ? ".public" : ""}:${r.method} ${r.path}`);
  }
  for (const t of p.tools ?? []) keys.push(`permissions.tools:${t}`);
  for (const h of p.hooks ?? []) keys.push(`permissions.hooks:${h}`);
  for (const m of p.models ?? []) keys.push(`permissions.models:${m.purpose} (${m.kind})`);
  for (const d of p.network ?? []) keys.push(`permissions.network:${d}`);
  for (const v of p.ui?.views ?? []) keys.push(`${UI_VIEW_KEY_PREFIX}${v}`);
  for (const e of p.ui?.embeds ?? []) keys.push(`ui.embed:${e}`);
  return sortedUnique(keys);
}

/** 渲染 schema 视图的权限键前缀：记入快照但不卡加载（见 {@link blockingKeys}）。 */
export const UI_VIEW_KEY_PREFIX = "ui.view:";

/**
 * 新增项里需要批准（卡加载）的部分：除 `ui.view:*` 之外的全部。视图只是把插件已有的数据交给内核组件来画，
 * 不给插件新能力（spec §4.1），升级多出视图时插件照常加载、快照自动补上。
 */
export function blockingKeys(added: readonly string[]): string[] {
  return added.filter((k) => !k.startsWith(UI_VIEW_KEY_PREFIX));
}

/** 两份权限集合的差异（按 {@link permissionKeys}）；`prev` 为空（无快照）时全部算新增。 */
export function diffPermissions(
  prev: PermissionSet | undefined,
  next: PermissionSet,
): { added: string[]; removed: string[] } {
  const a = new Set(prev ? permissionKeys(prev) : []);
  const b = new Set(permissionKeys(next));
  return {
    added: [...b].filter((k) => !a.has(k)),
    removed: [...a].filter((k) => !b.has(k)),
  };
}
