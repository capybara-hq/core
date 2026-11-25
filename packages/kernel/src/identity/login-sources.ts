import {
  IDENTITY_SOURCE_EXTENSION_POINT,
  type IdentitySource,
  validateTenantId,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import { z } from "zod";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { STALE_RECONCILE_PERIODS } from "../extensions/lifecycle-topics.js";
import { missingOverridable } from "../extensions/org-levels.js";
import { ExtensionRegistry } from "../extensions/registry.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { audit } from "./audit.js";

/** The `deployment_settings` key of the login sources (login extensions spec §1). */
export const LOGIN_SOURCES_SETTING = "loginSources";
/** At most this many trusted tenants per source. */
export const MAX_TRUSTED_TENANTS = 50;
/** A tenant id is the `<tenant>` of a source key: non-empty, no whitespace, at most 256 chars. */
const TENANT_MAX = 256;

const LoginSourceSettingsSchema = z.object({
  plugin: z.string().min(1).max(214),
  enabled: z.boolean(),
  signUp: z.enum(["link", "create"]),
  trustedTenants: z.array(z.string().min(1).max(TENANT_MAX)).max(MAX_TRUSTED_TENANTS),
});
const LoginSourcesValue = z.array(LoginSourceSettingsSchema);

/**
 * One login source: an extension providing `identity-source@1`, whether the login page offers
 * it, what happens to an unlinked external account, and the tenants trusted for email merge.
 */
export type LoginSourceSettings = z.infer<typeof LoginSourceSettingsSchema>;

/** The patch {@link LoginSourcesService.update} takes. */
export type LoginSourcePatch = Partial<Omit<LoginSourceSettings, "plugin">>;

/** An enabled login source whose extension is loaded and provides the point. */
export interface EnabledLoginSource {
  plugin: string;
  source: IdentitySource;
  settings: LoginSourceSettings;
}

/** A new entry: off, unlinked accounts go to the link page, nothing trusted. */
const defaults = (plugin: string): LoginSourceSettings => ({
  plugin,
  enabled: false,
  signUp: "link",
  trustedTenants: [],
});

/**
 * Parses a stored value: missing → `[]`; invalid → `[]` with a warning (the login page then
 * offers nothing and nothing is trusted; the next write replaces the row).
 */
export function parseLoginSources(
  value: unknown,
  log?: Pick<KernelLogger, "warn">,
): LoginSourceSettings[] {
  if (value === undefined) return [];
  const parsed = LoginSourcesValue.safeParse(value);
  if (parsed.success) return parsed.data;
  log?.warn("invalid deployment setting; it reads as no login sources", {
    key: LOGIN_SOURCES_SETTING,
  });
  return [];
}

/**
 * Enabled entries first (in their order), then the disabled ones (in theirs): the login page
 * order is the order of the enabled entries.
 */
function enabledFirst(list: LoginSourceSettings[]): LoginSourceSettings[] {
  return [...list.filter((e) => e.enabled), ...list.filter((e) => !e.enabled)];
}

/**
 * Writes the whole list (upsert by key) through `db`; `actorAccountId` is recorded as the row's
 * `updated_by`. No checks beyond the schema: {@link LoginSourcesService} checks before it writes,
 * and test seeds write through here directly.
 */
export async function writeLoginSources(
  db: KernelSchemaDb,
  list: LoginSourceSettings[],
  actorAccountId: string | null,
): Promise<void> {
  const json = JSON.stringify(LoginSourcesValue.parse(list));
  await db
    .insertInto("deployment_settings")
    .values({ key: LOGIN_SOURCES_SETTING, value: json, updated_by: actorAccountId })
    .onConflict((oc) =>
      oc
        .column("key")
        .doUpdateSet({ value: json, updated_by: actorAccountId, updated_at: sql`now()` }),
    )
    .execute();
}

const invalidTenant = (plugin: string, tenant: string, reason: string): ApiError =>
  new ApiError(
    "login_sources.invalid_tenant",
    `Trusted tenant "${tenant}" of ${plugin} is not valid: ${reason}`,
    [{ path: "trustedTenants", message: reason }],
  );

const TENANT_REASONS = {
  empty: "a tenant id cannot be blank",
  pattern: "it does not match the tenant format this source declares",
  never_trusted: "this source declares that this tenant may never be trusted",
} as const;

/**
 * The login sources (login extensions spec §1): one `deployment_settings` row, key
 * `loginSources`, an array of {@link LoginSourceSettings} whose order is the login page order.
 * Read from PG at every call, never cached in process (every replica sees a change at once).
 * An entry whose extension is not loaded or no longer provides `identity-source@1` is kept but
 * not offered. Writes lock the row, run in one transaction and audit `login_sources.updated`.
 */
@Injectable()
export class LoginSourcesService {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(ExtensionRegistry)
    private readonly registry: Pick<ExtensionRegistry, "list" | "current">,
    @Inject(KernelConfigService) private readonly config: Pick<KernelConfigService, "get">,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<KernelLogger, "warn">,
  ) {}

  /** Every stored entry, in stored order (in the caller's transaction when there is one). */
  async list(): Promise<LoginSourceSettings[]> {
    const row = await this.db
      .selectFrom("deployment_settings")
      .select("value")
      .where("key", "=", LOGIN_SOURCES_SETTING)
      .executeTakeFirst();
    return parseLoginSources(row?.value, this.log);
  }

  /** The entries the login page offers: enabled, loaded and providing the point, in order. */
  async enabled(): Promise<EnabledLoginSource[]> {
    return (await this.list()).flatMap((settings) => {
      if (!settings.enabled) return [];
      const source = this.loadedSource(settings.plugin);
      return source ? [{ plugin: settings.plugin, source, settings }] : [];
    });
  }

  async get(plugin: string): Promise<LoginSourceSettings | undefined> {
    return (await this.list()).find((e) => e.plugin === plugin);
  }

  /**
   * Whether the source key `<plugin>:<tenant>` is trusted: the tenant is in that plugin's
   * `trustedTenants` (full key match, trust is per tenant, Ruling A19). Independent of `enabled`:
   * directory sync reads it for `email_verified` whether or not the login page offers the source.
   */
  async isTrusted(sourceKey: string): Promise<boolean> {
    const i = sourceKey.indexOf(":");
    if (i <= 0) return false;
    const plugin = sourceKey.slice(0, i);
    const tenant = sourceKey.slice(i + 1);
    return (await this.get(plugin))?.trustedTenants.includes(tenant) === true;
  }

  /**
   * Changes one entry (created with the defaults when missing). `login_sources.unknown_plugin`
   * when the extension is neither loaded as an identity source nor stored; trusted tenants are
   * trimmed, de-duplicated and checked against the source's tenant declaration (only blanks are
   * refused while it is not loaded); turning it on while its deployment config is invalid →
   * `login_sources.needs_config`, and puts it after the last enabled entry.
   */
  @Transactional()
  async update(
    plugin: string,
    patch: LoginSourcePatch,
    actorAccountId: string,
  ): Promise<LoginSourceSettings> {
    const current = await this.lockedList();
    const before = current.find((e) => e.plugin === plugin);
    const source = this.loadedSource(plugin);
    const turningOn = patch.enabled === true && before?.enabled !== true;
    // an extension waiting for its config is not loaded: needs_config says what to do next
    if (turningOn && (await this.needsConfig(plugin))) throw needsConfig(plugin);
    if (!source && !before) {
      throw new ApiError(
        "login_sources.unknown_plugin",
        `No extension providing identity-source@1 is named ${plugin}`,
      );
    }
    const next: LoginSourceSettings = { ...(before ?? defaults(plugin)) };
    if (patch.enabled !== undefined) next.enabled = patch.enabled;
    if (patch.signUp !== undefined) next.signUp = patch.signUp;
    if (patch.trustedTenants !== undefined) {
      next.trustedTenants = this.checkTenants(plugin, source, patch.trustedTenants);
    }
    const others = current.filter((e) => e.plugin !== plugin);
    let list: LoginSourceSettings[];
    if (turningOn || before === undefined) {
      list = enabledFirst([...others, next]);
    } else {
      list = enabledFirst(current.map((e) => (e.plugin === plugin ? next : e)));
    }
    await writeLoginSources(this.db.db, list, actorAccountId);
    await audit(this.db.db, {
      actorAccountId,
      action: "login_sources.updated",
      target: plugin,
      detail: { before: before ?? null, after: next },
    });
    return next;
  }

  /**
   * Sets the login page order: `plugins` must name every enabled stored entry exactly once
   * (available or not); the disabled entries follow in their stored order.
   */
  @Transactional()
  async reorder(plugins: string[], actorAccountId: string): Promise<LoginSourceSettings[]> {
    const current = await this.lockedList();
    const enabled = current.filter((e) => e.enabled);
    const byPlugin = new Map(enabled.map((e) => [e.plugin, e]));
    if (
      plugins.length !== enabled.length ||
      new Set(plugins).size !== plugins.length ||
      plugins.some((p) => !byPlugin.has(p))
    ) {
      throw new ApiError(
        "validation_failed",
        "The order must list every enabled login source exactly once",
        [
          {
            path: "plugins",
            message: `expected a permutation of: ${[...byPlugin.keys()].join(", ")}`,
          },
        ],
      );
    }
    const list = [
      ...plugins.map((p) => byPlugin.get(p) as LoginSourceSettings),
      ...current.filter((e) => !e.enabled),
    ];
    await writeLoginSources(this.db.db, list, actorAccountId);
    await audit(this.db.db, {
      actorAccountId,
      action: "login_sources.updated",
      detail: {
        before: current.map((e) => e.plugin),
        after: list.map((e) => e.plugin),
      },
    });
    return list;
  }

  /** The stored list with its row locked FOR UPDATE (created as `[]` first): writes serialize. */
  private async lockedList(): Promise<LoginSourceSettings[]> {
    await this.db
      .insertInto("deployment_settings")
      .values({ key: LOGIN_SOURCES_SETTING, value: "[]" })
      .onConflict((oc) => oc.column("key").doNothing())
      .execute();
    const row = await this.db
      .selectFrom("deployment_settings")
      .select("value")
      .where("key", "=", LOGIN_SOURCES_SETTING)
      .forUpdate()
      .executeTakeFirst();
    return parseLoginSources(row?.value, this.log);
  }

  /** The loaded `identity-source@1` implementation of `plugin` (live from the registry). */
  private loadedSource(plugin: string): IdentitySource | undefined {
    const entry = this.registry
      .list("identity-source")
      .find((e) => e.plugin === plugin && e.capability === IDENTITY_SOURCE_EXTENSION_POINT);
    return entry?.impl as IdentitySource | undefined;
  }

  private checkTenants(
    plugin: string,
    source: IdentitySource | undefined,
    tenants: string[],
  ): string[] {
    const out: string[] = [];
    for (const raw of tenants) {
      const id = raw.trim();
      const verdict = validateTenantId(source?.tenant, id);
      if (verdict !== "ok") throw invalidTenant(plugin, id, TENANT_REASONS[verdict]);
      if (/\s/.test(id) || id.length > TENANT_MAX) {
        throw invalidTenant(
          plugin,
          id,
          `a tenant id has no spaces and at most ${TENANT_MAX} characters`,
        );
      }
      if (!out.includes(id)) out.push(id);
    }
    if (out.length > MAX_TRUSTED_TENANTS) {
      throw new ApiError("validation_failed", "Too many trusted tenants", [
        { path: "trustedTenants", message: `at most ${MAX_TRUSTED_TENANTS}` },
      ]);
    }
    return out;
  }

  /**
   * Whether the extension's deployment config is invalid: loaded, the running config leaves a
   * required overridable field empty (the host loads with those fields optional, so that is the
   * only way the full schema can refuse it, as in `EffectiveConfigs.get`); not loaded, a live
   * replica reports it pending configuration.
   */
  private async needsConfig(plugin: string): Promise<boolean> {
    const inst = this.registry.current(plugin);
    if (inst) {
      const schema = inst.manifest.config?.deployment as z.ZodTypeAny | undefined;
      return schema !== undefined && missingOverridable(schema, inst.config).length > 0;
    }
    const staleSeconds =
      STALE_RECONCILE_PERIODS * this.config.get().extensionHost.reconcileIntervalSeconds;
    const row = await this.db
      .selectFrom("extension_replica_status")
      .select("plugin")
      .where("plugin", "=", plugin)
      .where("state", "=", "pending")
      .where("reason", "=", "config")
      .where("heartbeat_at", ">", sql<Date>`now() - make_interval(secs => ${staleSeconds})`)
      .limit(1)
      .executeTakeFirst();
    return row !== undefined;
  }
}

const needsConfig = (plugin: string): ApiError =>
  new ApiError(
    "login_sources.needs_config",
    `The deployment config of ${plugin} is not complete; fill it in before offering its sign-in`,
  );
