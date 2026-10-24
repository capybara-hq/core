import { isDeepStrictEqual } from "node:util";
import type { CapybaraPackageSection } from "@capybara-hq/plugin-sdk";
import { sql, type Transaction } from "kysely";
import type { core, z } from "zod";
import { configFields, describeSchema, getPath, secretValues } from "../config/fields.js";
import { type ConfigSourceKind, fieldSource } from "../config/sources.js";
import { createSecrets, type Keyring } from "../ctx/secrets.js";
import type { KernelDatabase, KernelDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { audit } from "../identity/audit.js";
import { lockEnterpriseAdminsAndAuthorize } from "../identity/enterprise-admin.js";
import { configToJsonSchema, type JsonSchema } from "./config-json-schema.js";
import { type ConfigIssue, toIssues } from "./org-config.js";

type Trx = Transaction<KernelDatabase>;
type Obj = Record<string, unknown>;

/** 部署级插件配置的密钥存在 `capybara.secrets` 的这个 org_id 下（不是真实组织；namespace `kernel`）。 */
export const DEPLOYMENT_SECRETS_ORG = "_deployment";
/** 内核自己的 secrets 命名空间（`kernel` 是保留插件名）。 */
const SECRETS_NAMESPACE = "kernel";
const SECRET_KEY_PREFIX = "plugin-deployment-config:";
const secretKey = (plugin: string, path: string) => `${SECRET_KEY_PREFIX}${plugin}:${path}`;

/**
 * 部署配置保存之后（kernel bus 主题，频道 `cap:kernel:plugin-deployment-config`，payload `{ plugin }`）：
 * 各副本重读并校验——只改了 hot 字段就地替换，改了非 hot 字段重新加载实例，不合法保持当前值并告警；
 * 插件此刻待配置时，下一次 reconcile 加载它。
 */
export const PLUGIN_DEPLOYMENT_CONFIG_TOPIC = "plugin-deployment-config";

export type { ConfigIssue };

/** 后台一个部署配置字段：来源、是否只读；非密钥字段给出生效值，密钥字段只给 `set`。 */
export interface DeploymentConfigField {
  path: string;
  secret: boolean;
  hot: boolean;
  /**
   * `env` / `file` / `nacos`：启动配置给了（只读）；`db`：后台保存的值；`default`：schema 默认值；`unset`：没有值。
   */
  source: ConfigSourceKind | "db" | "default" | "unset";
  readonly: boolean;
  /** 非密钥字段的生效值（没有值时省略）。 */
  value?: unknown;
  /** 密钥字段是否已设置（任何来源）；值永不回显。 */
  set?: boolean;
}

/** The response of `GET / PUT /api/v1/admin/extensions/:name/config`. */
export interface DeploymentConfigView {
  plugin: string;
  version: string;
  /** 插件声明了部署级配置。 */
  configurable: boolean;
  fields: DeploymentConfigField[];
  /** 部署级 schema 的 JSON Schema（密钥字段带 `x-secret`）；本副本拿不到模块（未加载的安装记录）时为 null。 */
  schema: JsonSchema | null;
  /** 生效配置按 schema 校验通过（`validated` 为 false 时没有校验，恒为 true，界面不要据此显示「合法」）。 */
  valid: boolean;
  /**
   * 本副本拿到了插件模块的 zod schema、`valid` / `issues` 是真实校验结果。false：未加载的安装记录，
   * 字段按包内静态清单给出，没有校验（加载时才校验，不合法则待配置）。
   */
  validated: boolean;
  /** 校验失败的原因（只有路径与说明，不含值）。 */
  issues: ConfigIssue[];
}

/** 一个插件的部署级配置描述：真实模块的 zod schema（有的话）与字段清单。 */
export interface DeploymentSchemaInfo {
  version: string;
  schema?: core.$ZodType | undefined;
  fields: { path: string; secret: boolean; hot: boolean }[];
}

/** 由 zod schema 得出字段清单（`configFields`：对象路径上的叶子，secret 向下继承）。 */
export function schemaFields(schema: core.$ZodType | undefined): DeploymentSchemaInfo["fields"] {
  if (!schema) return [];
  return configFields(schema).map((f) => ({
    path: f.path,
    secret: f.meta?.secret === true,
    hot: f.meta?.hot === true,
  }));
}

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** 按点路径设值，缺失的中间对象自动创建；中间节点不是对象时放弃。 */
function setDeep(obj: Obj, path: string, value: unknown): void {
  const segs = path.split(".");
  let node: Obj = obj;
  for (const seg of segs.slice(0, -1)) {
    const next = node[seg];
    if (next === undefined) node[seg] = {};
    else if (!isObj(next)) return;
    node = node[seg] as Obj;
  }
  node[segs[segs.length - 1] as string] = value;
}

/** 按点路径删除键；删完变空的中间对象一并删掉。 */
function deleteDeep(obj: Obj, path: string): void {
  const segs = path.split(".");
  const chain: Obj[] = [obj];
  let node: unknown = obj;
  for (const seg of segs.slice(0, -1)) {
    if (!isObj(node)) return;
    node = node[seg];
    if (!isObj(node)) return;
    chain.push(node);
  }
  delete (chain[chain.length - 1] as Obj)[segs[segs.length - 1] as string];
  for (let i = chain.length - 1; i > 0; i--) {
    if (Object.keys(chain[i] as Obj).length > 0) break;
    delete (chain[i - 1] as Obj)[segs[i - 1] as string];
  }
}

/** 叶子点路径（对象递归；其余都是叶子）。 */
function leafPaths(value: unknown, prefix = "", out: string[] = []): string[] {
  if (isObj(value)) {
    for (const [k, v] of Object.entries(value)) leafPaths(v, prefix ? `${prefix}.${k}` : k, out);
  } else if (prefix !== "") out.push(prefix);
  return out;
}

/** 启动配置（文件 / 环境变量合并后的值）是否覆盖了这个字段：给了它、它下面的值，或在祖先上给了非对象值。 */
function coveredBy(fileValue: unknown, path: string): boolean {
  let node = fileValue;
  for (const seg of path.split(".")) {
    if (node === undefined) return false;
    if (!isObj(node)) return true;
    node = node[seg];
  }
  return node !== undefined;
}

/**
 * 合并一个插件的部署配置（C10 的优先级：环境变量 > 文件 / Nacos > PG > schema 默认值）：以启动配置
 * （`fileValue`，已含环境变量）为底，逐字段补上 PG 里保存、而启动配置没有覆盖的值。按字段合并：启动配置给了的字段
 * 整个以它为准（不与 PG 的值深合并）。`fields` 为字段点路径（没有 schema 时用 PG 值的叶子路径）。默认值由校验补上。
 */
export function mergeDeploymentConfig(
  stored: Obj,
  fileValue: unknown,
  fields: string[] = leafPaths(stored),
): unknown {
  if (fileValue !== undefined && !isObj(fileValue)) return fileValue;
  const out: Obj = structuredClone((fileValue as Obj | undefined) ?? {});
  for (const path of fields) {
    const v = getPath(stored, path);
    if (v === undefined || coveredBy(fileValue, path)) continue;
    setDeep(out, path, structuredClone(v));
  }
  return out;
}

/**
 * PG 里一个插件保存的部署配置（非密钥字段 + 解密的密钥字段，按点路径放回对象）。只并入 `secretPaths`（当前
 * schema 里是密钥的字段）的密钥：旧版本留下、现在已不是密钥或已删掉的字段不解密、不并入（否则会被当成明文回显
 * 或保存）。
 */
export async function readStoredDeploymentConfig(
  db: KernelDb | Trx,
  keyring: Keyring,
  plugin: string,
  opts: { forUpdate?: boolean; secretPaths: readonly string[] },
): Promise<Obj> {
  let q = db
    .selectFrom("extension_deployment_configs")
    .select("config")
    .where("plugin", "=", plugin);
  if (opts.forUpdate) q = q.forUpdate();
  const row = await q.executeTakeFirst();
  const out: Obj = structuredClone(row?.config ?? {});
  const prefix = secretKey(plugin, "");
  const wanted = new Set(opts.secretPaths);
  if (wanted.size === 0) return out;
  const keys = await db
    .selectFrom("secrets")
    .select("key")
    .where("namespace", "=", SECRETS_NAMESPACE)
    .where("org_id", "=", DEPLOYMENT_SECRETS_ORG)
    .execute();
  const secrets = createSecrets(db, keyring, SECRETS_NAMESPACE);
  for (const { key } of keys) {
    if (!key.startsWith(prefix) || !wanted.has(key.slice(prefix.length))) continue;
    const v = await secrets.get(DEPLOYMENT_SECRETS_ORG, key);
    if (v !== null) setDeep(out, key.slice(prefix.length), JSON.parse(v));
  }
  return out;
}

/** 字段清单里的密钥字段路径。 */
export const secretPathsOf = (fields: DeploymentSchemaInfo["fields"]): string[] =>
  fields.filter((f) => f.secret).map((f) => f.path);

/** JSON Schema 转换按 schema 对象缓存（清单不可变）。 */
const jsonSchemaCache = new WeakMap<object, JsonSchema>();
function jsonSchemaOf(schema: core.$ZodType): JsonSchema {
  let js = jsonSchemaCache.get(schema);
  if (!js) {
    js = configToJsonSchema(schema as z.ZodType);
    jsonSchemaCache.set(schema, js);
  }
  return structuredClone(js);
}

/** 某字段 zod 叶子上的默认值（整份配置不合法、校验没能补上默认值时，视图仍按它显示）。 */
function defaultOf(schema: core.$ZodType, path: string): { has: boolean; value?: unknown } {
  const f = configFields(schema).find((x) => x.path === path);
  if (!f) return { has: false };
  const d = describeSchema(f.schema);
  return d.hasDefault ? { has: true, value: d.defaultValue } : { has: false };
}

export interface ExtensionDeploymentConfigDeps {
  db: KernelDb;
  keyring: Keyring;
  /** 启动配置里的 `extensionConfig`（文件 / Nacos 与环境变量合并后）。 */
  fileConfig: () => Record<string, unknown>;
  /** 启动配置各字段的来源（见 `extensionConfigSources`）；这些字段只读。 */
  sources: Record<string, Record<string, ConfigSourceKind>>;
  /** The extension's deployment config description; undefined when the deployment does not know the extension (`extension.not_found`). */
  schemaOf: (plugin: string) => Promise<DeploymentSchemaInfo | undefined>;
  /** 保存提交后发布 {@link PLUGIN_DEPLOYMENT_CONFIG_TOPIC}；失败只告警（各副本的周期 reconcile 会重读生效插件的部署配置兜底）。 */
  bus?: { publish(topic: string, payload: unknown): Promise<void> };
  /** 本副本立即应用（不等 bus 消息回到自己；其他副本经 bus）。失败只记 error。 */
  applyLocal?: (plugin: string) => Promise<unknown>;
  /** 经手的密钥值（提交后），内核传 `log.addSecrets`。 */
  onSecrets?: (values: string[]) => void;
  log: {
    warn(msg: string, fields?: Record<string, unknown>): void;
    error(msg: string, fields?: Record<string, unknown>): void;
  };
}

/**
 * Deployment-level extension config (D8 / C10): non-secret fields are stored in
 * `extension_deployment_configs`, each secret field encrypted in `capybara.secrets` (namespace
 * `kernel`, org `_deployment`, key `plugin-deployment-config:<plugin>:<path>`). Fields present in the
 * startup config (file / Nacos / env) are read-only and show their source; the effective value
 * follows {@link mergeDeploymentConfig}. No in-process state, shared by every replica.
 * Secret values are never echoed: responses only say "set", audits only record which paths changed.
 */
export class ExtensionDeploymentConfigService {
  constructor(private readonly d: ExtensionDeploymentConfigDeps) {}

  /** 插件的生效部署配置（未校验）：启动配置为底，补上 PG 里保存的字段。`schema` 给出时按它的字段合并。 */
  async effective(plugin: string, fileValue: unknown, schema?: core.$ZodType): Promise<unknown> {
    const stored = await readStoredDeploymentConfig(this.d.db, this.d.keyring, plugin, {
      secretPaths: secretPathsOf(schemaFields(schema)),
    });
    const fields = schema ? configFields(schema).map((f) => f.path) : undefined;
    return mergeDeploymentConfig(stored, fileValue, fields);
  }

  /** Admin view; an extension unknown to the deployment -> `extension.not_found`. */
  async view(plugin: string): Promise<DeploymentConfigView> {
    const info = await this.info(plugin);
    const stored = await this.d.db
      .transaction()
      .setIsolationLevel("repeatable read")
      .setAccessMode("read only")
      .execute((t) =>
        readStoredDeploymentConfig(t, this.d.keyring, plugin, {
          secretPaths: secretPathsOf(info.fields),
        }),
      );
    return this.render(plugin, info, stored);
  }

  /**
   * Saves some fields: `values` keyed by field dot path, `null` = clear (back to the default),
   * omitted = unchanged.
   * - Unknown to the deployment -> `extension.not_found`; no deployment config, unknown field, or
   *   invalid after merging (except a problem in a read-only startup-config field itself) ->
   *   `extension.config_invalid` (details carry only paths and messages);
   * - a field present in the startup config (file / Nacos / env) -> 409 `extension.config_readonly`.
   * In a transaction, first `lockEnterpriseAdminsAndAuthorize` (re-checks the enterprise admin under
   * the lock), then an advisory lock per extension; audit `extension.deployment_config_updated`
   * (detail only `changedPaths`). After the commit publishes {@link PLUGIN_DEPLOYMENT_CONFIG_TOPIC} and
   * applies it on this replica right away.
   */
  async put(
    plugin: string,
    values: Record<string, unknown>,
    actor: string,
    actorTokenId?: string,
  ): Promise<DeploymentConfigView> {
    const info = await this.info(plugin);
    if (info.fields.length === 0) {
      throw new ApiError(
        "extension.config_invalid",
        `Extension ${plugin} has no deployment config`,
      );
    }
    const byPath = new Map(info.fields.map((f) => [f.path, f]));
    const unknown = Object.keys(values).filter((p) => !byPath.has(p));
    if (unknown.length > 0) {
      throw new ApiError(
        "extension.config_invalid",
        `Unknown deployment config fields for extension ${plugin}`,
        unknown.map((path) => ({ path, message: "unknown field" })),
      );
    }
    const sources = this.d.sources[plugin];
    const readonly = Object.keys(values).filter((p) => fieldSource(sources, p) !== undefined);
    if (readonly.length > 0) {
      throw new ApiError(
        "extension.config_readonly",
        `These deployment config fields of extension ${plugin} are set in the startup config (file, Nacos or environment) and are read-only here: ${readonly.join(", ")}`,
        readonly.map((path) => ({ path, source: fieldSource(sources, path) })),
      );
    }
    const fileValue = this.d.fileConfig()[plugin];
    const fieldPaths = info.fields.map((f) => f.path);
    let saved: Obj | undefined;
    let changed: string[] = [];
    await this.d.db.transaction().execute(async (t) => {
      await lockEnterpriseAdminsAndAuthorize(t, actor);
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`capybara.plugin-deployment-config:${plugin}`}))`.execute(
        t,
      );
      const before = await readStoredDeploymentConfig(t, this.d.keyring, plugin, {
        forUpdate: true,
        secretPaths: secretPathsOf(info.fields),
      });
      const next = structuredClone(before);
      for (const [path, v] of Object.entries(values)) {
        if (v === null) deleteDeep(next, path);
        else setDeep(next, path, structuredClone(v));
      }
      if (info.schema) {
        const r = (info.schema as z.ZodType).safeParse(
          mergeDeploymentConfig(next, fileValue, fieldPaths),
        );
        if (!r.success) {
          // 启动配置里只读字段自己的问题这里改不了（照样保存，插件保持待配置），其余拒绝
          const issues = toIssues(r.error).filter(
            (i) => i.path === "" || fieldSource(sources, i.path) === undefined,
          );
          if (issues.length > 0) {
            throw new ApiError(
              "extension.config_invalid",
              `Invalid deployment config for extension ${plugin}`,
              issues,
            );
          }
        }
      }
      changed = Object.keys(values)
        .filter((p) => !isDeepStrictEqual(getPath(before, p), getPath(next, p)))
        .sort();
      saved = next;
      if (changed.length === 0) return;
      const plain = structuredClone(next);
      const secrets = createSecrets(t, this.d.keyring, SECRETS_NAMESPACE);
      for (const f of info.fields) {
        if (!f.secret) continue;
        deleteDeep(plain, f.path);
        if (!(f.path in values)) continue;
        const v = getPath(next, f.path);
        if (v === undefined)
          await secrets.delete(DEPLOYMENT_SECRETS_ORG, secretKey(plugin, f.path));
        else
          await secrets.set(DEPLOYMENT_SECRETS_ORG, secretKey(plugin, f.path), JSON.stringify(v));
      }
      await t
        .insertInto("extension_deployment_configs")
        .values({ plugin, config: JSON.stringify(plain), updated_by: actor })
        .onConflict((oc) =>
          oc.column("plugin").doUpdateSet({
            config: JSON.stringify(plain),
            updated_by: actor,
            updated_at: new Date(),
          }),
        )
        .execute();
      await audit(t, {
        actorAccountId: actor,
        ...(actorTokenId !== undefined && { actorTokenId }),
        action: "extension.deployment_config_updated",
        target: plugin,
        detail: { changedPaths: changed },
      });
    });
    const stored = saved ?? {};
    if (info.schema && this.d.onSecrets) {
      const values = secretValues(
        info.schema,
        mergeDeploymentConfig(stored, fileValue, fieldPaths),
      );
      if (values.length > 0) this.d.onSecrets(values);
    }
    if (changed.length > 0) {
      try {
        await this.d.bus?.publish(PLUGIN_DEPLOYMENT_CONFIG_TOPIC, { plugin });
      } catch (err) {
        this.d.log.warn("cannot publish plugin-deployment-config after saving", { plugin, err });
      }
      try {
        await this.d.applyLocal?.(plugin);
      } catch (err) {
        this.d.log.error("applying the plugin deployment config on this replica failed", {
          plugin,
          err,
        });
      }
    }
    return this.render(plugin, info, stored);
  }

  private async info(plugin: string): Promise<DeploymentSchemaInfo> {
    const info = await this.d.schemaOf(plugin);
    if (!info) {
      throw new ApiError(
        "extension.not_found",
        `Extension ${plugin} is not known to this deployment`,
      );
    }
    return info;
  }

  private render(plugin: string, info: DeploymentSchemaInfo, stored: Obj): DeploymentConfigView {
    const fileValue = this.d.fileConfig()[plugin];
    const sources = this.d.sources[plugin];
    const raw = mergeDeploymentConfig(
      stored,
      fileValue,
      info.fields.map((f) => f.path),
    );
    let effective: unknown = raw;
    let valid = true;
    let issues: ConfigIssue[] = [];
    if (info.schema) {
      const r = (info.schema as z.ZodType).safeParse(raw);
      if (r.success) effective = r.data;
      else {
        valid = false;
        issues = toIssues(r.error);
      }
    }
    const fields = info.fields.map((f): DeploymentConfigField => {
      const from = fieldSource(sources, f.path);
      let value = getPath(effective, f.path);
      let source: DeploymentConfigField["source"];
      if (from !== undefined) source = from;
      else if (getPath(stored, f.path) !== undefined) source = "db";
      else {
        const d = info.schema ? defaultOf(info.schema, f.path) : { has: false };
        if (value === undefined && d.has) value = d.value;
        source = value === undefined ? "unset" : "default";
      }
      const base = {
        path: f.path,
        secret: f.secret,
        hot: f.hot,
        source,
        readonly: from !== undefined,
      };
      if (f.secret) return { ...base, set: value !== undefined };
      return value === undefined ? base : { ...base, value: structuredClone(value) };
    });
    return {
      plugin,
      version: info.version,
      configurable: info.fields.length > 0,
      fields,
      schema: info.schema ? jsonSchemaOf(info.schema) : null,
      valid,
      validated: info.schema !== undefined,
      issues,
    };
  }
}

/**
 * 本副本拿不到模块时（未加载的安装记录）按包内审阅过的静态清单给出字段（没有 zod schema：不校验，加载时再校验）。
 */
export async function staticDeploymentSchema(
  db: KernelDb,
  plugin: string,
): Promise<DeploymentSchemaInfo | undefined> {
  const row = await db
    .selectFrom("extension_installs")
    .innerJoin("extension_packages", "extension_packages.sha256", "extension_installs.sha256")
    .select(["extension_installs.version", "extension_packages.section"])
    .where("extension_installs.name", "=", plugin)
    .executeTakeFirst();
  if (!row) return undefined;
  const section = row.section as CapybaraPackageSection;
  return {
    version: row.version,
    fields: (section.manifest.config?.deployment ?? []).map((f) => ({
      path: f.path,
      secret: f.secret,
      hot: f.hot,
    })),
  };
}
