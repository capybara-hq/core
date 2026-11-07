import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { z } from "zod";
import { configFields } from "../config/fields.js";
import { createSecrets, type Keyring } from "../ctx/secrets.js";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { CacheService } from "../infra/cache/cache.service.js";
import { Cacheable, CacheEvict } from "../infra/cache/cacheable.decorator.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { KERNEL_LOGGER, KEYRING } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { type ConfigIssue, toIssues } from "./config-issues.js";
import { deleteDeep, isObj, setDeep } from "./deployment-config-store.js";
import { enabledExtensionsByOrg } from "./enabled.js";
import { ExtensionHost } from "./host.js";
import { type FieldLevel, fieldLevels } from "./org-levels.js";

type Obj = Record<string, unknown>;

/** The kernel's own secrets namespace (`kernel` is a reserved plugin name). */
export const OVERRIDE_SECRETS_NAMESPACE = "kernel";
const OVERRIDE_KEY_PREFIX = "plugin-override:";
/**
 * Where a copy's secret field lives in `capybara.secrets` (under the org): a namespace of its own,
 * distinct from the org-only `plugin-config:<plugin>:<path>` (spec A §5.8).
 */
export const overrideSecretKey = (plugin: string, path: string) =>
  `${OVERRIDE_KEY_PREFIX}${plugin}:${path}`;

/**
 * The effective deployment config of an extension for an org (spec A §6): `ok` with the config
 * and where its overridable fields come from, or the validation issues (paths only, no values).
 */
export type EffectiveConfig =
  | { ok: true; config: unknown; source: "platform" | "copy" }
  | { ok: false; issues: ConfigIssue[] };

/** An org's stored copy: its non-secret values and its secrets by field dot path. */
export interface StoredCopy {
  config: Obj;
  secrets: Record<string, unknown>;
}

/** The secret leaf paths of a deployment schema. */
export function secretLeafPaths(schema: z.ZodTypeAny): string[] {
  return configFields(schema)
    .filter((f) => f.meta?.secret === true)
    .map((f) => f.path);
}

const under = (path: string, key: string) => path === key || path.startsWith(`${key}.`);

/** The secret leaf paths under the `override` top-level keys (the secrets a copy may hold). */
export function overrideSecretPaths(
  schema: z.ZodTypeAny,
  levels: Map<string, FieldLevel> = fieldLevels(schema),
): string[] {
  const keys = [...levels].filter(([, l]) => l === "override").map(([k]) => k);
  return secretLeafPaths(schema).filter((p) => keys.some((k) => under(p, k)));
}

/**
 * The platform's non-secret values of the `override` keys: what a new copy starts from (spec A
 * §5.4, platform secrets never enter a copy).
 */
export function platformOverrideValues(schema: z.ZodTypeAny, platform: unknown): Obj {
  const levels = fieldLevels(schema);
  const secrets = secretLeafPaths(schema);
  const out: Obj = {};
  for (const [key, level] of levels) {
    if (level !== "override") continue;
    const v = isObj(platform) ? platform[key] : undefined;
    if (v === undefined) continue;
    const tmp: Obj = { [key]: structuredClone(v) };
    for (const p of secrets) if (under(p, key)) deleteDeep(tmp, p);
    if (tmp[key] !== undefined) out[key] = tmp[key];
  }
  return out;
}

/**
 * The deployment config an org with a copy runs with, before validation (spec A §5.4): the
 * platform's values of the hidden and read-only keys, and for each `override` key the copy's value
 * (its non-secret part and its own secrets). An `override` key the copy does not hold (one that
 * became overridable after the copy was made) takes the platform's value with every secret leaf
 * removed: a copy never falls back to a platform secret, required or not. Copy values of keys that
 * are no longer `override` are ignored.
 */
export function mergeCopy(schema: z.ZodTypeAny, platform: unknown, copy: StoredCopy): Obj {
  const levels = fieldLevels(schema);
  const secrets = secretLeafPaths(schema);
  const plat: Obj = isObj(platform) ? platform : {};
  const out: Obj = {};
  for (const [key, level] of levels) {
    if (level !== "override") {
      if (plat[key] !== undefined) out[key] = structuredClone(plat[key]);
      continue;
    }
    const own: Obj = {};
    if (copy.config[key] !== undefined) own[key] = structuredClone(copy.config[key]);
    const keySecrets = secrets.filter((p) => under(p, key));
    // a secret never comes from the non-secret part, even a hand-edited one
    for (const p of keySecrets) deleteDeep(own, p);
    for (const p of keySecrets) {
      const v = copy.secrets[p];
      if (v !== undefined) setDeep(own, p, structuredClone(v));
    }
    if (own[key] !== undefined) {
      out[key] = own[key];
      continue;
    }
    if (plat[key] === undefined) continue;
    const fallback: Obj = { [key]: structuredClone(plat[key]) };
    for (const p of keySecrets) deleteDeep(fallback, p);
    if (fallback[key] !== undefined) out[key] = fallback[key];
  }
  return out;
}

/** The cached form of an org's copy: none (following), or the copy sealed with a derived key. */
type CachedCopy = { copy: false } | { copy: true; sealed: string };

const CACHE_KEY_INFO = "org-override-cache";
const IV_LEN = 12;
const TAG_LEN = 16;

/**
 * The effective extension config of an org (spec A §5.3, §5.4, §6): the platform's deployment
 * config while the org follows it, or the platform's values with the org's copy applied to the
 * overridable fields. Every org-bound call takes its config from here.
 *
 * The platform half is this replica's running config (`ctx.config`, so a platform change reaches
 * following orgs as soon as the instance has it); the org half (the copy row and its secrets) is
 * read from PG and cached in Redis per (org, plugin) through `@Cacheable`, sealed with a key
 * derived from the master keyring so no secret sits in Redis in clear. Copy writes evict it after
 * their commit. No in-process state.
 */
@Injectable()
export class EffectiveConfigs {
  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(CacheService) readonly cacheService: CacheService,
    @Inject(KEYRING) private readonly keyring: Keyring,
    @Inject(ExtensionHost) private readonly host: ExtensionHost,
    /** Secret values of a copy read here are masked in the logs. */
    @Inject(KERNEL_LOGGER) private readonly log: KernelLogger,
  ) {}

  private get db(): KernelSchemaDb {
    return this.kdb.db;
  }

  /**
   * The effective config of `plugin` for `orgId`. Following: the platform's config validated with
   * the full schema (a required overridable field the platform left empty -> `ok: false`). Copy:
   * {@link mergeCopy} validated with the full schema. An extension not running on this replica ->
   * `ok: false` with a root issue.
   */
  async get(orgId: string, plugin: string): Promise<EffectiveConfig> {
    const inst = this.host.current(plugin);
    if (!inst) {
      return {
        ok: false,
        issues: [{ path: "", segments: [], message: "the extension is not running" }],
      };
    }
    const schema = inst.manifest.config?.deployment as z.ZodTypeAny | undefined;
    if (!schema) return { ok: true, config: inst.config, source: "platform" };
    const levels = fieldLevels(schema);
    // without an overridable field there is no copy to apply, and the loaded config is complete
    if (![...levels.values()].includes("override")) {
      return { ok: true, config: inst.config, source: "platform" };
    }
    const copy = await this.copyOf(orgId, plugin);
    if (!copy) return validate(schema, inst.config, "platform");
    const values = Object.values(copy.secrets);
    if (values.length > 0) this.log.addOrgSecrets(values);
    return validate(schema, mergeCopy(schema, inst.config, copy), "copy");
  }

  /** The org's copy (decrypted), or undefined while it follows the platform. */
  async copyOf(orgId: string, plugin: string): Promise<StoredCopy | undefined> {
    const cached = await this.cachedCopy(orgId, plugin);
    if (!cached.copy) return undefined;
    const opened = this.open(orgId, plugin, cached.sealed);
    // sealed with a key no longer in the keyring: read through
    if (opened) return opened;
    const fresh = await this.readCopy(orgId, plugin);
    return fresh ?? undefined;
  }

  /** Evicts the cached copy of (org, plugin) after the caller's commit. */
  @CacheEvict({ key: "effective-config:#{0}:#{1}" })
  async evict(_orgId: string, _plugin: string): Promise<void> {}

  /** Bypassed inside a transaction (a write reads its own rows). */
  @Cacheable({ key: "effective-config:#{0}:#{1}", ttl: 300 })
  private async cachedCopy(orgId: string, plugin: string): Promise<CachedCopy> {
    const copy = await this.readCopy(orgId, plugin);
    return copy ? { copy: true, sealed: this.seal(orgId, plugin, copy) } : { copy: false };
  }

  /**
   * The copy row and its secrets from one snapshot (joins the caller's transaction, so a write
   * sees what it just wrote).
   */
  @Transactional({ isolationLevel: "repeatable read" })
  private async readCopy(orgId: string, plugin: string): Promise<StoredCopy | null> {
    const t = this.db;
    const row = await t
      .selectFrom("extension_org_overrides")
      .select("config")
      .where("plugin", "=", plugin)
      .where("org_id", "=", orgId)
      .executeTakeFirst();
    if (!row) return null;
    const prefix = overrideSecretKey(plugin, "");
    const keys = await t
      .selectFrom("secrets")
      .select("key")
      .where("namespace", "=", OVERRIDE_SECRETS_NAMESPACE)
      .where("org_id", "=", orgId)
      .where("key", "like", `${prefix}%`)
      .execute();
    const store = createSecrets(t, this.keyring, OVERRIDE_SECRETS_NAMESPACE);
    const secrets: Record<string, unknown> = {};
    for (const { key } of keys) {
      if (!key.startsWith(prefix)) continue;
      const v = await store.get(orgId, key);
      if (v !== null) secrets[key.slice(prefix.length)] = JSON.parse(v);
    }
    return { config: row.config ?? {}, secrets };
  }

  /**
   * The number of orgs (not deleted) where the extension is on and has no valid effective config
   * (spec A §5.4a). Following orgs share the platform's result; each copy is checked on its own.
   * 0 when the extension is not running on this replica.
   */
  async countNeedingConfig(plugin: string): Promise<number> {
    if (!this.host.current(plugin)) return 0;
    const rows = await this.db
      .selectFrom(enabledExtensionsByOrg(this.db).as("en"))
      .innerJoin("orgs", "orgs.id", "en.org_id")
      .leftJoin("extension_org_overrides as ov", (j) =>
        j.onRef("ov.org_id", "=", "en.org_id").onRef("ov.plugin", "=", "en.plugin"),
      )
      .select(["en.org_id as orgId", "ov.org_id as copyOrg"])
      .where("orgs.deleted_at", "is", null)
      .where("en.plugin", "=", plugin)
      .execute();
    let n = 0;
    let following: boolean | undefined;
    for (const r of rows) {
      if (r.copyOrg === null) {
        following ??= (await this.get(r.orgId, plugin)).ok;
        if (!following) n++;
      } else if (!(await this.get(r.orgId, plugin)).ok) n++;
    }
    return n;
  }

  private cacheKey() {
    return this.keyring.deriveKey(CACHE_KEY_INFO);
  }

  private seal(orgId: string, plugin: string, copy: StoredCopy): string {
    const keys = this.cacheKey();
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv("aes-256-gcm", keys.current, iv);
    cipher.setAAD(Buffer.from(`${orgId}\0${plugin}`, "utf8"));
    const data = Buffer.concat([cipher.update(JSON.stringify(copy), "utf8"), cipher.final()]);
    return `${keys.currentId}:${Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64")}`;
  }

  private open(orgId: string, plugin: string, sealed: string): StoredCopy | undefined {
    const at = sealed.indexOf(":");
    const key = at > 0 ? this.cacheKey().byId(sealed.slice(0, at)) : undefined;
    if (!key) return undefined;
    try {
      const blob = Buffer.from(sealed.slice(at + 1), "base64");
      const decipher = createDecipheriv("aes-256-gcm", key, blob.subarray(0, IV_LEN));
      decipher.setAAD(Buffer.from(`${orgId}\0${plugin}`, "utf8"));
      decipher.setAuthTag(blob.subarray(IV_LEN, IV_LEN + TAG_LEN));
      const plain = Buffer.concat([
        decipher.update(blob.subarray(IV_LEN + TAG_LEN)),
        decipher.final(),
      ]).toString("utf8");
      return JSON.parse(plain) as StoredCopy;
    } catch {
      return undefined;
    }
  }
}

function validate(
  schema: z.ZodTypeAny,
  value: unknown,
  source: "platform" | "copy",
): EffectiveConfig {
  const r = schema.safeParse(value);
  return r.success
    ? { ok: true, config: r.data, source }
    : { ok: false, issues: toIssues(r.error) };
}

/** A top-level key of a dot path. */
export const topKey = (path: string) => path.split(".")[0] as string;
