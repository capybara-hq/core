import { isDeepStrictEqual } from "node:util";
import { Inject, Injectable } from "@nestjs/common";
import type { z } from "zod";
import { configFields, getPath } from "../config/fields.js";
import { createSecrets, type Keyring } from "../ctx/secrets.js";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { audit } from "../identity/audit.js";
import { CacheService } from "../infra/cache/cache.service.js";
import { CacheEvict } from "../infra/cache/cacheable.decorator.js";
import { afterCommit } from "../infra/database/after-commit.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { KERNEL_LOGGER, KEYRING } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { OrgLock } from "../orgs/org-lock.js";
import { type ConfigIssue, toIssues } from "./config-issues.js";
import { configMessages, safeConfigFormSchema } from "./config-json-schema.js";
import { applySecretEntries, type SecretEntry } from "./deployment-config.js";
import { deleteDeep, setDeep } from "./deployment-config-store.js";
import {
  EffectiveConfigs,
  mergeCopy,
  OVERRIDE_SECRETS_NAMESPACE,
  overrideSecretKey,
  overrideSecretPaths,
  platformOverrideValues,
  type StoredCopy,
} from "./effective-config.js";
import { ExtensionHost } from "./host.js";
import type { ExtensionInstance } from "./instance.js";
import { type FieldLevel, fieldLevels } from "./org-levels.js";

type Obj = Record<string, unknown>;

/** One field of {@link OrgOverrideView}: a read-only or overridable deployment field. */
export interface OrgOverrideField {
  path: string;
  level: "readonly" | "override";
  secret: boolean;
  /** The platform's current value (non-secret) or only whether it is set (secret). */
  platform: { value?: unknown; set?: boolean };
  /** With a copy, on an overridable field: the copy's value, or whether its secret is set. */
  org?: { value?: unknown; set?: boolean };
  /** With a copy, on an overridable non-secret field: the copy's value differs from the platform's. */
  differs?: boolean;
}

/**
 * What an org admin sees of an extension's two-level config (spec A §5.3 to §5.6): whether the org
 * follows the platform or keeps a copy, the read-only and overridable fields (hidden fields never
 * appear), and whether the effective config is valid. Secrets give `set` only, never a value, and
 * are never compared.
 */
export interface OrgOverrideView {
  state: "following" | "copy";
  createdAt?: string;
  fields: OrgOverrideField[];
  valid: boolean;
  issues: ConfigIssue[];
}

/** One org copy in the admin's extension detail (spec A §5.7). */
export interface OrgOverrideSummary {
  orgId: string;
  orgName: string;
  createdAt: string;
  /** The overridable non-secret fields whose copy value differs from the platform's. */
  differing: string[];
  secrets: { path: string; set: boolean }[];
}

interface Actor {
  accountId: string;
  tokenId?: string | undefined;
}

/** What a write needs of the running extension. */
interface Running {
  inst: ExtensionInstance;
  schema: z.ZodTypeAny | undefined;
  levels: Map<string, FieldLevel>;
}

const levelOf = (levels: Map<string, FieldLevel>, path: string): FieldLevel =>
  levels.get(path.split(".")[0] as string) ?? "hidden";

const notOverridable = (plugin: string, paths: string[]) =>
  new ApiError(
    "extension.field_not_overridable",
    `These config fields of extension ${plugin} cannot be set by an organization: ${paths.join(", ")}`,
    paths.map((path) => ({ path })),
  );

const noCopy = (plugin: string) =>
  new ApiError(
    "extension.no_org_override",
    `This organization follows the platform configuration of extension ${plugin}`,
  );

/**
 * Org copies of an extension's overridable deployment config (spec A §5.4, §5.5, §5.8): one row of
 * `extension_org_overrides` per copy (its non-secret values), each secret in `capybara.secrets`
 * under the org (namespace `kernel`, key `plugin-override:<plugin>:<path>`), written in the same
 * transaction under the org row lock. Writes are org-audited and evict the cached copy after the
 * commit. Platform secrets never enter a copy.
 */
@Injectable()
export class OrgOverrides {
  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(CacheService) readonly cacheService: CacheService,
    @Inject(KEYRING) private readonly keyring: Keyring,
    @Inject(ExtensionHost) private readonly host: ExtensionHost,
    /** The org row lock: re-checks `org.extensions.manage` under the lock. */
    @Inject(OrgLock) private readonly orgLock: OrgLock,
    @Inject(EffectiveConfigs) private readonly effective: EffectiveConfigs,
    @Inject(KERNEL_LOGGER) private readonly log: KernelLogger,
  ) {}

  private get db(): KernelSchemaDb {
    return this.kdb.db;
  }

  private running(plugin: string): Running {
    const inst = this.host.current(plugin);
    if (!inst) throw new ApiError("extension.not_found", `Extension ${plugin} is not installed`);
    const schema = inst.manifest.config?.deployment as z.ZodTypeAny | undefined;
    return { inst, schema, levels: fieldLevels(schema) };
  }

  /** The org's view (read-only and overridable fields, the copy state and validity). */
  async view(orgId: string, plugin: string): Promise<OrgOverrideView> {
    return this.render(orgId, this.running(plugin));
  }

  /**
   * Saves overridable fields (`values` keyed by field dot path: `null` clears, omitted keeps;
   * secret fields too, as in the platform form) and secret record entries. The first save creates
   * the copy from the platform's non-secret overridable values plus `values` (secret fields start
   * empty). A path that is not an overridable field of the schema (read-only, hidden, unknown) ->
   * 400 `extension.field_not_overridable`; an invalid result (an empty required secret included)
   * -> 400 `extension.config_invalid`, nothing written. Audits `extension.org_override_saved`.
   */
  @CacheEvict({ key: "effective-config:#{0}:#{1}" })
  async save(
    orgId: string,
    plugin: string,
    values: Record<string, unknown>,
    secretEntries: readonly SecretEntry[],
    actor: Actor,
  ): Promise<OrgOverrideView> {
    const run = this.running(plugin);
    const fields = new Map(
      (run.schema ? configFields(run.schema) : []).map((f) => [f.path, f.meta?.secret === true]),
    );
    const paths = [...Object.keys(values), ...secretEntries.map((e) => e.path)];
    const refused = [
      ...new Set(paths.filter((p) => !fields.has(p) || levelOf(run.levels, p) !== "override")),
    ];
    if (refused.length > 0) throw notOverridable(plugin, refused);
    const badEntries = secretEntries.filter(
      (e) => fields.get(e.path) !== true || Object.hasOwn(values, e.path),
    );
    if (badEntries.length > 0) {
      throw new ApiError(
        "validation_failed",
        `Invalid secret entries for the organization config of extension ${plugin}`,
        badEntries.map((e) => ({
          path: e.path,
          message: Object.hasOwn(values, e.path)
            ? "given both in values and in secretEntries"
            : "not a secret field",
        })),
      );
    }
    return this.writeSave(orgId, plugin, run, fields, values, secretEntries, actor);
  }

  @Transactional()
  private async writeSave(
    orgId: string,
    plugin: string,
    run: Running,
    fields: Map<string, boolean>,
    values: Record<string, unknown>,
    secretEntries: readonly SecretEntry[],
    actor: Actor,
  ): Promise<OrgOverrideView> {
    const schema = run.schema as z.ZodTypeAny;
    const t = this.db;
    await this.orgLock.lockFor(orgId, actor.accountId, "org.extensions.manage");
    const row = await this.lockedRow(orgId, plugin);
    const platform = run.inst.config;
    const prior: StoredCopy | undefined = row
      ? { config: structuredClone(row.config), secrets: await this.readSecrets(orgId, plugin) }
      : undefined;
    const copy: StoredCopy = prior
      ? structuredClone(prior)
      : { config: platformOverrideValues(schema, platform), secrets: {} };
    for (const [path, v] of Object.entries(values)) {
      if (fields.get(path)) {
        if (v === null) delete copy.secrets[path];
        else copy.secrets[path] = structuredClone(v);
      } else if (v === null) deleteDeep(copy.config, path);
      else setDeep(copy.config, path, structuredClone(v));
    }
    if (secretEntries.length > 0) {
      const records: Obj = {};
      for (const e of secretEntries) {
        if (copy.secrets[e.path] !== undefined) {
          setDeep(records, e.path, structuredClone(copy.secrets[e.path]));
        }
      }
      applySecretEntries(records, secretEntries);
      for (const e of secretEntries) {
        const v = getPath(records, e.path);
        if (v === undefined) delete copy.secrets[e.path];
        else copy.secrets[e.path] = v;
      }
    }
    const merged = this.validated(plugin, run, copy);
    const before = prior ? mergeCopy(schema, platform, prior) : platform;
    const changed = [...new Set(touchedPaths(values, secretEntries))]
      .filter((p) => !isDeepStrictEqual(getPath(before, p), getPath(merged, p)))
      .sort();
    await t
      .insertInto("extension_org_overrides")
      .values({
        plugin,
        org_id: orgId,
        config: JSON.stringify(copy.config),
        created_by: actor.accountId,
        updated_by: actor.accountId,
      })
      .onConflict((oc) =>
        oc.columns(["plugin", "org_id"]).doUpdateSet({
          config: JSON.stringify(copy.config),
          updated_by: actor.accountId,
          updated_at: new Date(),
        }),
      )
      .execute();
    await this.writeSecrets(orgId, plugin, schema, run.levels, copy.secrets);
    await audit(t, {
      actorAccountId: actor.accountId,
      ...(actor.tokenId !== undefined && { actorTokenId: actor.tokenId }),
      orgId,
      action: "extension.org_override_saved",
      target: plugin,
      detail: { changedPaths: changed },
    });
    const secretValues = Object.values(copy.secrets);
    afterCommit(() => {
      if (secretValues.length > 0) this.log.addOrgSecrets(secretValues);
    });
    return this.render(orgId, run);
  }

  /**
   * Takes the platform's current values of non-secret overridable fields into the copy (spec A
   * §5.5); the copy stays a copy. A secret, read-only, hidden or unknown path -> 400
   * `extension.field_not_overridable`; no copy -> 404 `extension.no_org_override`. Audits
   * `extension.org_override_taken`.
   */
  @CacheEvict({ key: "effective-config:#{0}:#{1}" })
  async take(
    orgId: string,
    plugin: string,
    paths: string[],
    actor: Actor,
  ): Promise<OrgOverrideView> {
    const run = this.running(plugin);
    const fields = new Map(
      (run.schema ? configFields(run.schema) : []).map((f) => [f.path, f.meta?.secret === true]),
    );
    const refused = [
      ...new Set(
        paths.filter((p) => fields.get(p) !== false || levelOf(run.levels, p) !== "override"),
      ),
    ];
    if (refused.length > 0) throw notOverridable(plugin, refused);
    return this.writeTake(orgId, plugin, run, paths, actor);
  }

  @Transactional()
  private async writeTake(
    orgId: string,
    plugin: string,
    run: Running,
    paths: string[],
    actor: Actor,
  ): Promise<OrgOverrideView> {
    const t = this.db;
    await this.orgLock.lockFor(orgId, actor.accountId, "org.extensions.manage");
    const row = await this.lockedRow(orgId, plugin);
    if (!row) throw noCopy(plugin);
    const copy: StoredCopy = {
      config: structuredClone(row.config),
      secrets: await this.readSecrets(orgId, plugin),
    };
    const platform = run.inst.config;
    const changed: string[] = [];
    for (const p of [...new Set(paths)]) {
      const v = getPath(platform, p);
      if (!isDeepStrictEqual(getPath(copy.config, p), v)) changed.push(p);
      if (v === undefined) deleteDeep(copy.config, p);
      else setDeep(copy.config, p, structuredClone(v));
    }
    this.validated(plugin, run, copy);
    await t
      .updateTable("extension_org_overrides")
      .set({
        config: JSON.stringify(copy.config),
        updated_by: actor.accountId,
        updated_at: new Date(),
      })
      .where("plugin", "=", plugin)
      .where("org_id", "=", orgId)
      .execute();
    await audit(t, {
      actorAccountId: actor.accountId,
      ...(actor.tokenId !== undefined && { actorTokenId: actor.tokenId }),
      orgId,
      action: "extension.org_override_taken",
      target: plugin,
      detail: { changedPaths: changed.sort() },
    });
    return this.render(orgId, run);
  }

  /**
   * Drops the copy and every secret of it in one transaction; the org follows the platform again
   * (spec A §5.5). No copy -> 404 `extension.no_org_override`. Audits `extension.org_override_reset`.
   */
  @CacheEvict({ key: "effective-config:#{0}:#{1}" })
  async reset(orgId: string, plugin: string, actor: Actor): Promise<OrgOverrideView> {
    return this.writeReset(orgId, plugin, this.running(plugin), actor);
  }

  @Transactional()
  private async writeReset(
    orgId: string,
    plugin: string,
    run: Running,
    actor: Actor,
  ): Promise<OrgOverrideView> {
    const t = this.db;
    await this.orgLock.lockFor(orgId, actor.accountId, "org.extensions.manage");
    const gone = await t
      .deleteFrom("extension_org_overrides")
      .where("plugin", "=", plugin)
      .where("org_id", "=", orgId)
      .returning("plugin")
      .executeTakeFirst();
    if (!gone) throw noCopy(plugin);
    const store = createSecrets(t, this.keyring, OVERRIDE_SECRETS_NAMESPACE);
    for (const key of await this.secretKeys(orgId, plugin)) await store.delete(orgId, key);
    await audit(t, {
      actorAccountId: actor.accountId,
      ...(actor.tokenId !== undefined && { actorTokenId: actor.tokenId }),
      orgId,
      action: "extension.org_override_reset",
      target: plugin,
    });
    return this.render(orgId, run);
  }

  /**
   * The orgs (not deleted) holding a copy of the extension, oldest first, with the overridable
   * non-secret fields that differ from the platform and whether each copy secret is set (spec A
   * §5.7); never a secret value. Differences need the running schema: an extension not running on
   * this replica lists no differences and only the secrets the copies hold.
   */
  @Transactional({ isolationLevel: "repeatable read", accessMode: "read only" })
  async listForPlugin(plugin: string): Promise<OrgOverrideSummary[]> {
    const t = this.db;
    const rows = await t
      .selectFrom("extension_org_overrides as ov")
      .innerJoin("orgs", "orgs.id", "ov.org_id")
      .select(["ov.org_id", "orgs.name", "ov.created_at", "ov.config"])
      .where("ov.plugin", "=", plugin)
      .where("orgs.deleted_at", "is", null)
      .orderBy("ov.created_at")
      .orderBy("ov.org_id")
      .execute();
    const inst = this.host.current(plugin);
    const schema = inst?.manifest.config?.deployment as z.ZodTypeAny | undefined;
    const levels = fieldLevels(schema);
    const secretPaths = schema ? overrideSecretPaths(schema, levels) : undefined;
    const plain = schema
      ? configFields(schema).filter(
          (f) => f.meta?.secret !== true && levelOf(levels, f.path) === "override",
        )
      : [];
    const out: OrgOverrideSummary[] = [];
    for (const r of rows) {
      const keys = await this.secretKeys(r.org_id, plugin);
      const prefix = overrideSecretKey(plugin, "");
      const held = new Set(keys.map((k) => k.slice(prefix.length)));
      out.push({
        orgId: r.org_id,
        orgName: r.name,
        createdAt: new Date(r.created_at).toISOString(),
        differing: plain
          .filter((f) => {
            const own = getPath(r.config, f.path);
            return own !== undefined && !isDeepStrictEqual(own, getPath(inst?.config, f.path));
          })
          .map((f) => f.path),
        secrets: (secretPaths ?? [...held].sort()).map((path) => ({ path, set: held.has(path) })),
      });
    }
    return out;
  }

  /** The merged copy validated with the full schema; invalid -> 400 `extension.config_invalid`. */
  private validated(plugin: string, run: Running, copy: StoredCopy): Obj {
    const schema = run.schema as z.ZodTypeAny;
    const merged = mergeCopy(schema, run.inst.config, copy);
    const r = schema.safeParse(merged);
    if (!r.success) {
      throw new ApiError(
        "extension.config_invalid",
        `Invalid organization copy of the configuration of extension ${plugin}`,
        orgIssues(toIssues(r.error, this.messagesOf(plugin, run)), run.levels),
      );
    }
    return merged;
  }

  private messagesOf(plugin: string, run: Running) {
    if (!run.schema) return undefined;
    const r = safeConfigFormSchema(run.schema, "deployment", (err, fallback) =>
      this.log.warn(
        "the deployment config form schema could not be built with its UI hints; hints dropped",
        { plugin, version: run.inst.manifest.version, schema: fallback, err },
      ),
    );
    return configMessages(r?.schema);
  }

  private async lockedRow(orgId: string, plugin: string) {
    return this.db
      .selectFrom("extension_org_overrides")
      .select(["config", "created_at"])
      .where("plugin", "=", plugin)
      .where("org_id", "=", orgId)
      .forUpdate()
      .executeTakeFirst();
  }

  /** The keys of the org's copy secrets for `plugin` (any path, current or stale). */
  private async secretKeys(orgId: string, plugin: string): Promise<string[]> {
    const prefix = overrideSecretKey(plugin, "");
    const rows = await this.db
      .selectFrom("secrets")
      .select("key")
      .where("namespace", "=", OVERRIDE_SECRETS_NAMESPACE)
      .where("org_id", "=", orgId)
      .where("key", "like", `${prefix}%`)
      .execute();
    return rows.map((r) => r.key).filter((k) => k.startsWith(prefix));
  }

  private async readSecrets(orgId: string, plugin: string): Promise<Record<string, unknown>> {
    const prefix = overrideSecretKey(plugin, "");
    const store = createSecrets(this.db, this.keyring, OVERRIDE_SECRETS_NAMESPACE);
    const out: Record<string, unknown> = {};
    for (const key of await this.secretKeys(orgId, plugin)) {
      const v = await store.get(orgId, key);
      if (v !== null) out[key.slice(prefix.length)] = JSON.parse(v);
    }
    return out;
  }

  /** Writes the copy's secrets of the current schema and drops stale keys (paths no longer secret). */
  private async writeSecrets(
    orgId: string,
    plugin: string,
    schema: z.ZodTypeAny,
    levels: Map<string, FieldLevel>,
    secrets: Record<string, unknown>,
  ): Promise<void> {
    const store = createSecrets(this.db, this.keyring, OVERRIDE_SECRETS_NAMESPACE);
    const live = overrideSecretPaths(schema, levels);
    for (const p of live) {
      const v = secrets[p];
      if (v === undefined) await store.delete(orgId, overrideSecretKey(plugin, p));
      else await store.set(orgId, overrideSecretKey(plugin, p), JSON.stringify(v));
    }
    const keep = new Set(live.map((p) => overrideSecretKey(plugin, p)));
    for (const key of await this.secretKeys(orgId, plugin)) {
      if (!keep.has(key)) await store.delete(orgId, key);
    }
  }

  private async render(orgId: string, run: Running): Promise<OrgOverrideView> {
    const row = await this.db
      .selectFrom("extension_org_overrides")
      .select(["config", "created_at"])
      .where("plugin", "=", run.inst.name)
      .where("org_id", "=", orgId)
      .executeTakeFirst();
    const held = row ? new Set(await this.secretPathsHeld(orgId, run.inst.name)) : new Set();
    const platform = run.inst.config;
    const fields: OrgOverrideField[] = [];
    for (const f of run.schema ? configFields(run.schema) : []) {
      const level = levelOf(run.levels, f.path);
      if (level === "hidden") continue;
      const secret = f.meta?.secret === true;
      const pv = getPath(platform, f.path);
      const field: OrgOverrideField = {
        path: f.path,
        level,
        secret,
        platform: secret
          ? { set: pv !== undefined }
          : pv === undefined
            ? {}
            : { value: structuredClone(pv) },
      };
      if (row && level === "override") {
        if (secret) field.org = { set: held.has(f.path) };
        else {
          const ov = getPath(row.config, f.path);
          field.org = ov === undefined ? {} : { value: structuredClone(ov) };
          field.differs = ov !== undefined && !isDeepStrictEqual(ov, pv);
        }
      }
      fields.push(field);
    }
    const eff = await this.effective.get(orgId, run.inst.name);
    return {
      state: row ? "copy" : "following",
      ...(row && { createdAt: new Date(row.created_at).toISOString() }),
      fields,
      valid: eff.ok,
      issues: eff.ok ? [] : orgIssues(eff.issues, run.levels),
    };
  }

  private async secretPathsHeld(orgId: string, plugin: string): Promise<string[]> {
    const prefix = overrideSecretKey(plugin, "");
    return (await this.secretKeys(orgId, plugin)).map((k) => k.slice(prefix.length));
  }
}

/** Every path a save touches. */
function touchedPaths(values: Record<string, unknown>, entries: readonly SecretEntry[]): string[] {
  return [...Object.keys(values), ...entries.map((e) => e.path)];
}

/**
 * Issues as an org may see them: an issue on a hidden field would name a field the org never
 * sees, so those collapse into one root issue.
 */
export function orgIssues(issues: ConfigIssue[], levels: Map<string, FieldLevel>): ConfigIssue[] {
  const shown = issues.filter((i) => i.path !== "" && levelOf(levels, i.path) !== "hidden");
  if (shown.length === issues.length) return issues;
  return [
    ...shown,
    {
      path: "",
      segments: [],
      message: "the platform configuration of this extension is incomplete",
    },
  ];
}
