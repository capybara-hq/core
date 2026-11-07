import { isDeepStrictEqual } from "node:util";
import type { LocalizedName, PluginExtensionSection } from "@capybara-hq/plugin-sdk";
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
import { SuperAdminLock } from "../identity/super-admin.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { KERNEL_BUS, KERNEL_LOGGER, KEYRING } from "../infra/tokens.js";
import { KERNEL_APP_OPTIONS } from "../lifecycle/tokens.js";
import type { KernelLogger } from "../log.js";
import type { PublishBus } from "./admin-view.js";
import { type ConfigIssue, toIssues } from "./config-issues.js";
import {
  checkConfigUi,
  configMessages,
  hintedSecretPaths,
  type JsonSchema,
  safeConfigFormSchema,
} from "./config-json-schema.js";
import {
  DEPLOYMENT_SECRETS_ORG,
  type DeploymentSchemaInfo,
  deleteDeep,
  isObj,
  mergeDeploymentConfig,
  readStoredDeploymentConfig,
  SECRETS_NAMESPACE,
  schemaFields,
  secretKey,
  secretPathsOf,
  setDeep,
} from "./deployment-config-store.js";
import { ExtensionDisplayNames } from "./display-name.js";
import { ExtensionHost } from "./host.js";
import { ExtensionInstalls } from "./installs.js";
import { ExtensionLifecycle } from "./lifecycle.js";
import { PLUGIN_DEPLOYMENT_CONFIG_TOPIC } from "./lifecycle-topics.js";
import { PluginDeploymentConfigLock } from "./locks.js";
import {
  type FieldLevel,
  fieldLevels,
  jsonSchemaFieldLevels,
  missingOverridable,
  relaxOverridable,
} from "./org-levels.js";

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
  /**
   * Only on a secret record some `x-ui.secrets[].path` names: the record's keys that are set, sorted
   * (item names, not secret values; spec §4.3). Other secret fields report only `set`.
   */
  keys?: string[];
  /**
   * What orgs may do with the field (spec A §5.1, the level of its top-level key): `readonly` (they
   * see it) or `override` (they may bring their own value); absent = hidden from orgs.
   */
  org?: "readonly" | "override";
}

/**
 * One operation on a secret record drawn per item (spec §4.3), only for a path some
 * `x-ui.secrets[].path` names: `renameFrom` moves an existing value to `key` (nothing when it has
 * none, replacing a value already at `key`), then `value` sets it (a string) or removes it (`null`).
 */
export interface SecretEntry {
  path: string;
  key: string;
  value?: string | null | undefined;
  renameFrom?: string | undefined;
}

/** The response of `GET / PUT /api/v1/admin/extensions/:name/config`. */
export interface DeploymentConfigView {
  plugin: string;
  /** The plugin's display name (`ExtensionDisplayNames`); null when it has none. */
  displayName: LocalizedName | null;
  version: string;
  /** 插件声明了部署级配置。 */
  configurable: boolean;
  fields: DeploymentConfigField[];
  /**
   * 部署级 schema 的 JSON Schema（密钥字段带 `x-secret`，提示 `x-ui` / `x-hot`）。本副本拿不到模块（未加载的
   * 安装记录）时取包内的 `extension.configSchemas.deployment`（`validated` 为 false）；旧包没有它时为 null。
   */
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
  /**
   * The required `override` fields the platform left empty (spec A §5.4a): the extension still
   * loads, and every org that follows the platform must configure them itself.
   */
  orgMustConfigure: string[];
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
    /** The super admin lock (identity/super-admin.ts): joins the transaction. */
    @Inject(SuperAdminLock) private readonly adminLock: SuperAdminLock,
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
    @Inject(ExtensionDisplayNames) private readonly displayNames: ExtensionDisplayNames,
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
    const [stored, displayName] = await Promise.all([
      this.readStored(plugin, info),
      this.displayNames.get(plugin),
    ]);
    return this.render(plugin, info, stored, displayName);
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
   * `secretEntries` change single keys of secret records some `x-ui.secrets[].path` names
   * ({@link SecretEntry}; spec §4.3): applied under the same locks to the decrypted record, which
   * is re-encrypted whole, then validated with `values`; the audit lists the record's path, no keys.
   * A path no hint names -> 400 `validation_failed`; one in the startup config -> 409
   * `extension.config_readonly`.
   * In a transaction, first `lockSuperAdminsAndAuthorize` (re-checks the super admin under
   * the lock), then an advisory lock per extension; audit `extension.deployment_config_updated`
   * (detail only `changedPaths`). After the commit publishes {@link PLUGIN_DEPLOYMENT_CONFIG_TOPIC} and
   * applies it on this replica right away.
   */
  async put(
    plugin: string,
    values: Record<string, unknown>,
    actor: string,
    actorTokenId?: string,
    secretEntries: readonly SecretEntry[] = [],
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
    this.checkSecretEntries(plugin, info, values, secretEntries);
    const sources = this.sources[plugin];
    const entryPaths = [...new Set(secretEntries.map((e) => e.path))];
    const readonly = [...Object.keys(values), ...entryPaths].filter(
      (p) => fieldSource(sources, p) !== undefined,
    );
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
      secretEntries,
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
    return this.render(plugin, info, stored, await this.displayNames.get(plugin));
  }

  /**
   * Secret entries name a secret record field some hint names (else 400 `validation_failed`, also
   * for a path given in `values` too, an entry with neither `value` nor `renameFrom`, or a key
   * `__proto__`). Messages carry paths and keys only, never values.
   */
  private checkSecretEntries(
    plugin: string,
    info: DeploymentSchemaInfo,
    values: Record<string, unknown>,
    entries: readonly SecretEntry[],
  ): void {
    if (entries.length === 0) return;
    const hinted = this.hintedPaths(plugin, info);
    const secret = new Set(secretPathsOf(info.fields));
    const problems: { path: string; message: string }[] = [];
    for (const e of entries) {
      if (!hinted.has(e.path) || !secret.has(e.path)) {
        problems.push({ path: e.path, message: "no config UI hint draws this secret per item" });
      } else if (Object.hasOwn(values, e.path)) {
        problems.push({ path: e.path, message: "given both in values and in secretEntries" });
      } else if (e.value === undefined && e.renameFrom === undefined) {
        problems.push({ path: e.path, message: `entry ${e.key} has neither value nor renameFrom` });
      } else if (e.key === "__proto__" || e.renameFrom === "__proto__") {
        problems.push({ path: e.path, message: "__proto__ is not a valid key" });
      }
    }
    if (problems.length > 0) {
      throw new ApiError(
        "validation_failed",
        `Invalid secret entries for the deployment config of extension ${plugin}`,
        problems,
      );
    }
  }

  @Transactional()
  private async write(
    plugin: string,
    values: Record<string, unknown>,
    secretEntries: readonly SecretEntry[],
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
    applySecretEntries(next, secretEntries);
    const touched = new Set([...Object.keys(values), ...secretEntries.map((e) => e.path)]);
    if (info.schema) {
      // overridable fields may stay empty on the platform (spec A §5.4a)
      const r = relaxOverridable(info.schema as z.ZodTypeAny).safeParse(
        mergeDeploymentConfig(next, fileValue, fieldPaths),
      );
      if (!r.success) {
        // 启动配置里只读字段自己的问题这里改不了（照样保存，插件保持待配置），其余拒绝
        const issues = toIssues(r.error, this.messagesOf(plugin, info)).filter(
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
    changed = [...touched]
      .filter((p) => !isDeepStrictEqual(getPath(before, p), getPath(next, p)))
      .sort();
    const saved = next;
    if (changed.length === 0) return { saved, changed };
    const plain = structuredClone(next);
    const secrets = createSecrets(t, this.keyring, SECRETS_NAMESPACE);
    for (const f of info.fields) {
      if (!f.secret) continue;
      deleteDeep(plain, f.path);
      if (!touched.has(f.path)) continue;
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

  private render(
    plugin: string,
    info: DeploymentSchemaInfo,
    stored: Obj,
    displayName: LocalizedName | null,
  ): DeploymentConfigView {
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
      // the load gate: overridable fields may stay empty (spec A §5.4a)
      const r = relaxOverridable(info.schema as z.ZodTypeAny).safeParse(raw);
      if (r.success) effective = r.data;
      else {
        valid = false;
        issues = toIssues(r.error, this.messagesOf(plugin, info));
      }
    }
    const formSchema = this.formSchemaOf(plugin, info);
    const hinted = formSchema ? hintedSecretPaths(formSchema) : new Set<string>();
    const levels = levelsOf(info);
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
      const level = levels.get(f.path.split(".")[0] as string);
      const base = {
        path: f.path,
        secret: f.secret,
        hot: f.hot,
        source,
        readonly: from !== undefined,
        ...(level !== undefined && level !== "hidden" && { org: level }),
      };
      // a schema default (e.g. `secret(record).default({})`) is no secret anybody set
      const set = value !== undefined && source !== "default";
      if (f.secret && hinted.has(f.path)) {
        // record keys are item names, never values
        return { ...base, set, keys: set && isObj(value) ? Object.keys(value).sort() : [] };
      }
      if (f.secret) return { ...base, set };
      return value === undefined ? base : { ...base, value: structuredClone(value) };
    });
    return {
      plugin,
      displayName,
      version: info.version,
      configurable: info.fields.length > 0,
      fields,
      schema: structuredClone(formSchema ?? null),
      valid,
      validated: info.schema !== undefined,
      issues,
      orgMustConfigure: orgMustConfigureOf(info, raw, levels),
    };
  }

  /**
   * The required `override` fields the platform left empty ({@link DeploymentConfigView}
   * `orgMustConfigure`); reads nothing when the extension has no `override` field. Unknown to the
   * deployment -> `extension.not_found`.
   */
  async orgMustConfigure(plugin: string): Promise<string[]> {
    const info = await this.info(plugin);
    const levels = levelsOf(info);
    if (![...levels.values()].includes("override")) return [];
    const stored = await this.readStored(plugin, info);
    const raw = mergeDeploymentConfig(
      stored,
      this.fileConfig()[plugin],
      info.fields.map((f) => f.path),
    );
    return orgMustConfigureOf(info, raw, levels);
  }

  /**
   * The form JSON Schema of the description: the zod schema's, else the package's static one. A
   * hint conversion that throws (a hand-made package) drops the hints: the plain schema, or none
   * when even the conversion fails; one warning per schema. Never throws.
   */
  private formSchemaOf(plugin: string, info: DeploymentSchemaInfo): JsonSchema | undefined {
    if (!info.schema) return info.jsonSchema;
    const r = safeConfigFormSchema(info.schema as z.ZodTypeAny, "deployment", (err, schema) =>
      this.log.warn(
        "the deployment config form schema could not be built with its UI hints; hints dropped",
        { plugin, version: info.version, schema, err },
      ),
    );
    return r?.schema;
  }

  private messagesOf(plugin: string, info: DeploymentSchemaInfo) {
    const js = this.formSchemaOf(plugin, info);
    return js && configMessages(js);
  }

  /** The secret record paths some hint of the form schema names. */
  private hintedPaths(plugin: string, info: DeploymentSchemaInfo): Set<string> {
    const js = this.formSchemaOf(plugin, info);
    return js ? hintedSecretPaths(js) : new Set();
  }
}

/** The org level of each top-level key: from the zod schema, else the package's form schema. */
function levelsOf(info: DeploymentSchemaInfo): Map<string, FieldLevel> {
  return info.schema
    ? fieldLevels(info.schema as z.ZodTypeAny)
    : jsonSchemaFieldLevels(info.jsonSchema);
}

/**
 * The required `override` keys `raw` leaves empty: by the zod schema, else (a static form schema)
 * the `required` keys marked `override` that have no value.
 */
function orgMustConfigureOf(
  info: DeploymentSchemaInfo,
  raw: unknown,
  levels: Map<string, FieldLevel>,
): string[] {
  if (info.schema) return missingOverridable(info.schema as z.ZodTypeAny, raw);
  const required = (info.jsonSchema as { required?: unknown } | undefined)?.required;
  if (!Array.isArray(required)) return [];
  return [...levels]
    .filter(([k, l]) => l === "override" && required.includes(k) && getPath(raw, k) === undefined)
    .map(([k]) => k);
}

/**
 * Applies secret entries in order to the decrypted config `next` (in place): each record is read
 * from `next` at its path, renamed, set or removed, and put back; an empty record is removed (the
 * field falls back to its default).
 */
function applySecretEntries(next: Obj, entries: readonly SecretEntry[]): void {
  for (const e of entries) {
    const cur = getPath(next, e.path);
    const rec: Record<string, unknown> = isObj(cur) ? { ...cur } : {};
    if (e.renameFrom !== undefined && e.renameFrom !== e.key && Object.hasOwn(rec, e.renameFrom)) {
      rec[e.key] = rec[e.renameFrom];
      delete rec[e.renameFrom];
    }
    if (e.value === null) delete rec[e.key];
    else if (e.value !== undefined) rec[e.key] = e.value;
    if (Object.keys(rec).length === 0) deleteDeep(next, e.path);
    else setDeep(next, e.path, rec);
  }
}

/**
 * 本副本拿不到模块时（未加载的安装记录）按包内审阅过的静态清单给出字段（没有 zod schema：不校验，加载时再校验）。
 * The package's `extension.configSchemas.deployment` (written by the packer) is the form schema;
 * its hints are checked like a loaded schema's (stripped when invalid, silently: a hand-made
 * package). It is not compared with the module (not part of `manifest_mismatch`, spec §4.5).
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
  const section = row.section as Pick<PluginExtensionSection, "manifest" | "configSchemas">;
  const stored = section.configSchemas?.deployment;
  let jsonSchema: JsonSchema | undefined;
  if (typeof stored === "object" && stored !== null && !Array.isArray(stored)) {
    jsonSchema = structuredClone(stored);
    checkConfigUi(jsonSchema, "deployment");
  }
  return {
    version: row.version,
    ...(jsonSchema !== undefined && { jsonSchema }),
    fields: (section.manifest.config?.deployment ?? []).map((f) => ({
      path: f.path,
      secret: f.secret,
      hot: f.hot,
    })),
  };
}
