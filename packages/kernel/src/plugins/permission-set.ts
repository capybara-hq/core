import { readdir, readFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import type { PluginManifest } from "@capybara-hq/plugin-sdk";
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
  };
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const sortedUnique = (xs: readonly string[] | undefined) => [...new Set(xs ?? [])].sort(cmp);

const IDENT = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)`;
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
  const p = manifest.permissions ?? {};
  return {
    provides: sortedUnique(manifest.provides),
    requires: sortedUnique(manifest.requires),
    optional: sortedUnique(manifest.optional),
    config: {
      deployment: fieldsOf(manifest.config?.deployment),
      org: fieldsOf(manifest.config?.org),
    },
    tables: sortedUnique(tables),
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
    },
  };
}

/**
 * 权限集合的稳定字符串键（排序），如 `provides:channel@1`、`config.org.secret:apiKey`、`table:todos`、
 * `permissions.tools:write`、`permissions.http.public:POST /events`。
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
  return sortedUnique(keys);
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
