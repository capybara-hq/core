import { isDeepStrictEqual } from "node:util";
import type { PluginExtensionSection } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import type { core, z } from "zod";
import type { KernelAppOptions } from "../app.js";
import { configFields, describeSchema, getPath, secretValues } from "../config/fields.js";
import {
  type ConfigSourceKind,
  configSourceKind,
  extensionConfigSources,
  fieldSource,
} from "../config/sources.js";
import { createSecrets, type Keyring } from "../ctx/secrets.js";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { audit } from "../identity/audit.js";
import { EnterpriseAdminLock } from "../identity/enterprise-admin.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { KERNEL_BUS, KERNEL_LOGGER, KEYRING } from "../infra/tokens.js";
import { KERNEL_APP_OPTIONS } from "../lifecycle/tokens.js";
import type { KernelLogger } from "../log.js";
import type { PublishBus } from "./admin-view.js";
import { type ConfigIssue, toIssues } from "./config-issues.js";
import { configToJsonSchema, type JsonSchema } from "./config-json-schema.js";
import {
  DEPLOYMENT_SECRETS_ORG,
  type DeploymentSchemaInfo,
  deleteDeep,
  mergeDeploymentConfig,
  readStoredDeploymentConfig,
  SECRETS_NAMESPACE,
  schemaFields,
  secretKey,
  secretPathsOf,
  setDeep,
} from "./deployment-config-store.js";
import { ExtensionHost } from "./host.js";
import { ExtensionInstalls } from "./installs.js";
import { ExtensionLifecycle } from "./lifecycle.js";
import { PLUGIN_DEPLOYMENT_CONFIG_TOPIC } from "./lifecycle-topics.js";
import { PluginDeploymentConfigLock } from "./locks.js";

export {
  DEPLOYMENT_SECRETS_ORG,
  type DeploymentSchemaInfo,
  mergeDeploymentConfig,
  readStoredDeploymentConfig,
  schemaFields,
  secretPathsOf,
};

type Obj = Record<string, unknown>;

export type { ConfigIssue };
export { PLUGIN_DEPLOYMENT_CONFIG_TOPIC };

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

/**
 * Deployment-level extension config (D8 / C10): non-secret fields are stored in
 * `extension_deployment_configs`, each secret field encrypted in `capybara.secrets` (namespace
 * `kernel`, org `_deployment`, key `plugin-deployment-config:<plugin>:<path>`). Fields present in the
 * startup config (file / Nacos / env) are read-only and show their source; the effective value
 * follows {@link mergeDeploymentConfig}. No in-process state, shared by every replica.
 * Secret values are never echoed: responses only say "set", audits only record which paths changed.
 */
@Injectable()
export class ExtensionDeploymentConfigService {
  /** Where each startup-config field comes from (see `extensionConfigSources`); those fields are read-only. */
  private readonly sources: Record<string, Record<string, ConfigSourceKind>>;

  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    /** The enterprise admin lock (identity/enterprise-admin.ts): joins the transaction. */
    @Inject(EnterpriseAdminLock) private readonly adminLock: EnterpriseAdminLock,
    @Inject(PluginDeploymentConfigLock) private readonly configLock: PluginDeploymentConfigLock,
    @Inject(KEYRING) private readonly keyring: Keyring,
    @Inject(KernelConfigService) private readonly config: KernelConfigService,
    /** This replica's extension schemas (loaded, config-declared or prepared install records). */
    @Inject(ExtensionHost) private readonly host: ExtensionHost,
    /** The effective (stored plus startup) deployment config. */
    @Inject(ExtensionInstalls) private readonly installs: ExtensionInstalls,
    /** Applies a saved config on this replica at once (other replicas through the bus). */
    @Inject(ExtensionLifecycle) private readonly lifecycle: ExtensionLifecycle,
    /** Publishes {@link PLUGIN_DEPLOYMENT_CONFIG_TOPIC} after a save (a failure only warns). */
    @Inject(KERNEL_BUS) private readonly bus: PublishBus,
    @Inject(KERNEL_LOGGER) private readonly log: KernelLogger,
    @Inject(KERNEL_APP_OPTIONS) options: Pick<KernelAppOptions, "env" | "extensionConfigSources">,
  ) {
    const env = options.env ?? process.env;
    this.sources =
      options.extensionConfigSources ??
      extensionConfigSources(
        { extensionConfig: config.get().extensionConfig },
        env,
        configSourceKind(env),
      );
  }

  private get db(): KernelSchemaDb {
    return this.kdb.db;
  }

  /** The startup config's `extensionConfig` (file / Nacos merged with env). */
  private fileConfig(): Record<string, unknown> {
    return this.config.get().extensionConfig;
  }

  /**
   * The extension's deployment config description; undefined when the deployment does not know
   * the extension (`extension.not_found`). Public for tests only.
   */
  async schemaOf(plugin: string): Promise<DeploymentSchemaInfo | undefined> {
    const local = this.host.deploymentSchema(plugin);
    if (local) return { ...local, fields: schemaFields(local.schema) };
    // 与配置声明重名的安装记录不生效
    if (this.host.declared().has(plugin)) return undefined;
    return staticDeploymentSchema(this.db, plugin);
  }

  /** 插件的生效部署配置（未校验）：启动配置为底，补上 PG 里保存的字段。`schema` 给出时按它的字段合并。 */
  effective(plugin: string, fileValue: unknown, schema?: core.$ZodType): Promise<unknown> {
    return this.installs.effectiveDeploymentConfig(plugin, fileValue, schema);
  }

  /** Admin view; an extension unknown to the deployment -> `extension.not_found`. */
  async view(plugin: string): Promise<DeploymentConfigView> {
    const info = await this.info(plugin);
    const stored = await this.readStored(plugin, info);
    return this.render(plugin, info, stored);
  }

  /** `REPEATABLE READ` read-only: every stored field from one snapshot. */
  @Transactional({
    propagation: "requires_new",
    isolationLevel: "repeatable read",
    accessMode: "read only",
  })
  private readStored(plugin: string, info: DeploymentSchemaInfo): Promise<Obj> {
    return readStoredDeploymentConfig(this.db, this.keyring, plugin, {
      secretPaths: secretPathsOf(info.fields),
    });
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
    const sources = this.sources[plugin];
    const readonly = Object.keys(values).filter((p) => fieldSource(sources, p) !== undefined);
    if (readonly.length > 0) {
      throw new ApiError(
        "extension.config_readonly",
        `These deployment config fields of extension ${plugin} are set in the startup config (file, Nacos or environment) and are read-only here: ${readonly.join(", ")}`,
        readonly.map((path) => ({ path, source: fieldSource(sources, path) })),
      );
    }
    const fileValue = this.fileConfig()[plugin];
    const fieldPaths = info.fields.map((f) => f.path);
    const { saved, changed } = await this.write(
      plugin,
      values,
      actor,
      actorTokenId,
      info,
      sources,
      fileValue,
    );
    const stored = saved ?? {};
    if (info.schema) {
      const secrets = secretValues(
        info.schema,
        mergeDeploymentConfig(stored, fileValue, fieldPaths),
      );
      if (secrets.length > 0) this.log.addSecrets(secrets);
    }
    if (changed.length > 0) {
      try {
        await this.bus.publish(PLUGIN_DEPLOYMENT_CONFIG_TOPIC, { plugin });
      } catch (err) {
        this.log.warn("cannot publish plugin-deployment-config after saving", { plugin, err });
      }
      try {
        await this.lifecycle.applyConfig(plugin);
      } catch (err) {
        this.log.error("applying the plugin deployment config on this replica failed", {
          plugin,
          err,
        });
      }
    }
    return this.render(plugin, info, stored);
  }

  @Transactional()
  private async write(
    plugin: string,
    values: Record<string, unknown>,
    actor: string,
    actorTokenId: string | undefined,
    info: DeploymentSchemaInfo,
    sources: Record<string, ConfigSourceKind> | undefined,
    fileValue: unknown,
  ): Promise<{ saved: Obj | undefined; changed: string[] }> {
    const fieldPaths = info.fields.map((f) => f.path);
    let changed: string[] = [];
    const t = this.db;
    await this.adminLock.lockAndAuthorize(actor);
    await this.configLock.lock(plugin);
    const before = await readStoredDeploymentConfig(t, this.keyring, plugin, {
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
    const saved = next;
    if (changed.length === 0) return { saved, changed };
    const plain = structuredClone(next);
    const secrets = createSecrets(t, this.keyring, SECRETS_NAMESPACE);
    for (const f of info.fields) {
      if (!f.secret) continue;
      deleteDeep(plain, f.path);
      if (!(f.path in values)) continue;
      const v = getPath(next, f.path);
      if (v === undefined) await secrets.delete(DEPLOYMENT_SECRETS_ORG, secretKey(plugin, f.path));
      else await secrets.set(DEPLOYMENT_SECRETS_ORG, secretKey(plugin, f.path), JSON.stringify(v));
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
    return { saved, changed };
  }

  private async info(plugin: string): Promise<DeploymentSchemaInfo> {
    const info = await this.schemaOf(plugin);
    if (!info) {
      throw new ApiError(
        "extension.not_found",
        `Extension ${plugin} is not known to this deployment`,
      );
    }
    return info;
  }

  private render(plugin: string, info: DeploymentSchemaInfo, stored: Obj): DeploymentConfigView {
    const fileValue = this.fileConfig()[plugin];
    const sources = this.sources[plugin];
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
  db: KernelSchemaDb,
  plugin: string,
): Promise<DeploymentSchemaInfo | undefined> {
  const row = await db
    .selectFrom("extension_installs")
    .innerJoin("extension_packages", "extension_packages.sha256", "extension_installs.sha256")
    .select(["extension_installs.version", "extension_packages.section"])
    .where("extension_installs.name", "=", plugin)
    .executeTakeFirst();
  if (!row) return undefined;
  // new rows hold the plugin's extension section, pre-0.1.0 rows the old capybara section; both
  // carry the static manifest
  const section = row.section as Pick<PluginExtensionSection, "manifest">;
  return {
    version: row.version,
    fields: (section.manifest.config?.deployment ?? []).map((f) => ({
      path: f.path,
      secret: f.secret,
      hot: f.hot,
    })),
  };
}
