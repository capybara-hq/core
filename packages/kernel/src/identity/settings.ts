import { EXTENSION_NAME_RE } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import {
  applyDevicesAutoModePatch,
  DEVICES_AUTO_MODE_PATCH,
  DEVICES_AUTO_MODE_SETTING,
  type DevicesAutoMode,
  type DevicesAutoModePatch,
  type DevicesAutoModeStored,
  type DevicesAutoModeView,
  readDevicesAutoMode,
  readStoredDevicesAutoMode,
} from "../sandbox/platform-auto-mode.js";
import { assertPlatformDefaultEligible, lockThemeShared } from "../themes/theme-state.js";
import {
  mergeArrangement,
  type UiArrangement,
  UiArrangementPatchSchema,
  UiArrangementSchema,
} from "../ui/arrangement.js";
import { audit } from "./audit.js";
import { SuperAdminLock } from "./super-admin.js";

/** 币种代码：ISO 4217 的三位大写字母（如 USD、CNY）。 */
const CurrencyCode = z.string().regex(/^[A-Z]{3}$/, "must be a 3-letter ISO 4217 currency code");

/** 沙箱 cpu（核）与内存（MB）覆盖的范围（C19）。 */
export const SANDBOX_CPU_RANGE = { min: 0.25, max: 64 } as const;
export const SANDBOX_MEMORY_MB_RANGE = { min: 256, max: 262_144 } as const;

/** 一个组织的沙箱限额覆盖：至少给一项；未给的项用部署默认。 */
export const SANDBOX_LIMIT_OVERRIDE = z
  .object({
    cpu: z.number().min(SANDBOX_CPU_RANGE.min).max(SANDBOX_CPU_RANGE.max).optional(),
    memoryMb: z
      .number()
      .int()
      .min(SANDBOX_MEMORY_MB_RANGE.min)
      .max(SANDBOX_MEMORY_MB_RANGE.max)
      .optional(),
  })
  .strict()
  .refine((o) => o.cpu !== undefined || o.memoryMb !== undefined, {
    message: "give cpu, memoryMb or both",
  });
export type SandboxLimitOverride = z.infer<typeof SANDBOX_LIMIT_OVERRIDE>;

/**
 * One organization's sub-agent limits (sub-agents spec §8.2, agent map spec §6): any of the
 * `subagents.*` values, within the same bounds (0 for dispatches or tokens: no limit); the ones not
 * given use the deployment's config.
 */
export const SUBAGENT_LIMIT_OVERRIDE = z
  .object({
    maxDepth: z.number().int().min(1).max(5).optional(),
    maxConcurrentPerConversation: z.number().int().min(1).max(20).optional(),
    maxDispatchesPerRun: z
      .number()
      .int()
      .max(500)
      .refine((n) => n === 0 || n >= 1, "0 (no limit) or 1 to 500")
      .optional(),
    maxTokensPerRun: z
      .number()
      .int()
      .refine((n) => n === 0 || n >= 10_000, "0 (no limit) or at least 10,000")
      .optional(),
  })
  .strict()
  .refine((o) => Object.values(o).some((v) => v !== undefined), {
    message: "give maxDepth, maxConcurrentPerConversation, maxDispatchesPerRun or maxTokensPerRun",
  });
export type SubagentLimitOverride = z.infer<typeof SUBAGENT_LIMIT_OVERRIDE>;

/** 组织能否自建连接器 / 技能（C22）：`deny` 时只能从平台目录安装（T26 执行）。 */
const CustomPolicy = z.enum(["allow", "deny"]);

/** The deployment setting key of the platform default theme (themes spec §7). */
export const UI_THEME_SETTING = "uiTheme";

/**
 * The platform default theme (themes spec §7): a `platform_themes` id, or null for the built-in
 * theme. Only a platform-owned theme whose effective scope is `all` can be set (checked by
 * {@link SettingsService.update}); every reader goes through {@link readUiTheme} or
 * {@link SettingsService.get}, both parsing with this schema.
 */
export const UiThemeSetting = z.object({ id: z.string().min(1).max(200).nullable() });
export type UiTheme = z.infer<typeof UiThemeSetting>;

/** The deployment setting key of the client code kill switch (client extensions spec §10.2). */
export const CLIENT_EXTENSIONS_SETTING = "clientExtensions";

/** The plugins listed in `clientExtensions.disabled`: at most this many. */
export const CLIENT_DISABLED_MAX = 200;

const ClientDisabledList = z
  .array(z.string().regex(EXTENSION_NAME_RE, "must be an extension name"))
  .max(CLIENT_DISABLED_MAX);

/**
 * The client code kill switch (client extensions spec §10.2): `enabled: false` stops every plugin's
 * client code (the shell reads list nothing, delivery is 404); `disabled` names the plugins whose
 * client code alone is stopped while their server side keeps running. Every reader goes through
 * {@link readClientExtensions} or {@link SettingsService.get}.
 */
export const ClientExtensionsSetting = z.object({
  enabled: z.boolean(),
  disabled: ClientDisabledList,
});
export type ClientExtensionsKillSwitch = z.infer<typeof ClientExtensionsSetting>;

/** The kill switch's default (and what a missing or invalid stored value reads as): everything on. */
export const clientExtensionsDefault = (): ClientExtensionsKillSwitch => ({
  enabled: true,
  disabled: [],
});

/**
 * Parses a stored `clientExtensions` value (the `deployment_settings` row's `value`, undefined when
 * the row is missing): the default when missing; when invalid the default too, with a warning naming
 * the key (a kill switch that fails open is worth a log line, as {@link SettingsService.get} logs
 * every other invalid key). The one parser of the setting: the settings service and every access
 * check read through it.
 */
export function parseClientExtensions(
  value: unknown,
  log?: Pick<KernelLogger, "warn">,
): ClientExtensionsKillSwitch {
  if (value === undefined) return clientExtensionsDefault();
  const parsed = ClientExtensionsSetting.safeParse(value);
  if (parsed.success) return parsed.data;
  log?.warn("invalid deployment setting; using default", {
    key: CLIENT_EXTENSIONS_SETTING,
    issues: parsed.error.issues.map((i) => i.message),
  });
  return clientExtensionsDefault();
}

export const DEPLOYMENT_SETTINGS = z.object({
  orgCreation: z.enum(["anyone", "super_admin"]).default("anyone"),
  /** 按组织覆盖运行并发上限（orgId → 上限）；未列出的组织用 `runtime.orgConcurrency`。 */
  runConcurrencyOverrides: z.record(z.string().min(1), z.number().int().positive()).default({}),
  /** 模型价格表（`model_prices`）的币种；只用于显示估算成本，不做换算。 */
  priceCurrency: CurrencyCode.default("USD"),
  /** 按组织覆盖沙箱 cpu / 内存（orgId → 覆盖，C19）；只对之后新建的沙箱生效。组织管理员只读。 */
  sandboxLimitOverrides: z.record(z.string().min(1), SANDBOX_LIMIT_OVERRIDE).default({}),
  /**
   * Per-organization sub-agent limits (orgId → override); organizations not listed, and values
   * not given, use `subagents.*`. Read live on every dispatch and tool resolution.
   */
  subagentLimitOverrides: z.record(z.string().min(1), SUBAGENT_LIMIT_OVERRIDE).default({}),
  /** 组织能否自建连接器（不经平台目录）。 */
  customConnectors: CustomPolicy.default("allow"),
  /**
   * Whether the org can create its own skills (not through the platform catalog): on deny org admins
   * cannot upload skill packages. An agent registering its own skill (`agents.register-skill`) is not
   * governed by it; only sharing a skill to the org is refused.
   */
  customSkills: CustomPolicy.default("allow"),
  /**
   * Org admins may browse the marketplaces read-only and ask for an entry to be imported (plugin
   * scope spec §5.1 rule 3). false hides the browse route and refuses those requests.
   */
  orgMarketplaceBrowse: z.boolean().default(true),
  /** The platform default theme (themes spec §7); `{ id: null }`: the built-in theme. */
  uiTheme: UiThemeSetting.default({ id: null }),
  /**
   * The platform default arrangement of UI slots (UI slots spec §5): `{ hidden, order }` per list
   * slot, `{ use }` per single slot (client extensions spec §6.3); orgs override per slot.
   */
  uiArrangement: UiArrangementSchema.default({}),
  /** The client code kill switch (client extensions spec §10.2). */
  clientExtensions: ClientExtensionsSetting.default(clientExtensionsDefault),
});
export type DeploymentSettings = z.infer<typeof DEPLOYMENT_SETTINGS>;

const DEFAULTS: DeploymentSettings = DEPLOYMENT_SETTINGS.parse({});

/**
 * What `GET /api/v1/admin/settings` answers: the stored settings, and the platform's auto-mode
 * switch as it is in effect with where it comes from (`env` / `file` / `nacos`: the startup
 * config, read-only here; `db`: chosen in the admin console; `default`).
 */
export type DeploymentSettingsView = DeploymentSettings & { devicesAutoMode: DevicesAutoModeView };

const autoModeWidenRefused = (): ApiError =>
  new ApiError(
    "deployment.auto_mode_not_allowed",
    "Turning auto mode on at the platform level (devicesAutoMode) needs a super admin in the admin console; an API token or the Platform tool may only turn it off.",
  );

/**
 * 设置的修改（PUT /api/v1/admin/settings 的 body）：只改给出的键。
 * `runConcurrencyOverrides` 按组织合并：值为正整数 → 设置该组织的上限；值为 null → 删除该组织的覆盖
 * （回到 `runtime.orgConcurrency`）；未列出的组织保持不变。
 * `sandboxLimitOverrides` 同样按组织合并：给出的组织整项替换（未给的 cpu / memoryMb 回到部署默认），null 删除。
 * `subagentLimitOverrides` merges by organization the same way: a given organization's entry is
 * replaced whole (values left out go back to `subagents.*`), null removes it.
 */
export const DEPLOYMENT_SETTINGS_PATCH = z
  .object({
    orgCreation: z.enum(["anyone", "super_admin"]).optional(),
    runConcurrencyOverrides: z
      .record(z.string().min(1), z.number().int().positive().nullable())
      .optional(),
    priceCurrency: CurrencyCode.optional(),
    sandboxLimitOverrides: z
      .record(z.string().min(1), SANDBOX_LIMIT_OVERRIDE.nullable())
      .optional(),
    subagentLimitOverrides: z
      .record(z.string().min(1), SUBAGENT_LIMIT_OVERRIDE.nullable())
      .optional(),
    customConnectors: CustomPolicy.optional(),
    customSkills: CustomPolicy.optional(),
    orgMarketplaceBrowse: z.boolean().optional(),
    /**
     * The platform default theme: a platform-owned theme whose effective scope is `all`, not
     * disabled (else 400 `theme.not_available`), or `{ id: null }` for the built-in theme.
     */
    uiTheme: UiThemeSetting.strict().optional(),
    /**
     * Per slot, the entry to hide / order contributions with (`{ use }` on a single slot); null
     * removes a slot's entry.
     */
    uiArrangement: UiArrangementPatchSchema.optional(),
    /**
     * The client code kill switch: each given field replaces the stored one (`disabled` is the
     * whole list, stored sorted without duplicates); at least one field.
     */
    clientExtensions: z
      .object({ enabled: z.boolean().optional(), disabled: ClientDisabledList.optional() })
      .strict()
      .refine((o) => o.enabled !== undefined || o.disabled !== undefined, {
        message: "give enabled, disabled or both",
      })
      .optional(),
    /**
     * The platform's auto-mode switch (auto mode spec §4.3, P-D9): `mode` replaced, null clears it
     * (back to the default, allowed). A value set in the startup config is read-only (409
     * `deployment.setting_readonly`); an API token or the Platform tool may only turn it off (400
     * `deployment.auto_mode_not_allowed`).
     */
    devicesAutoMode: DEVICES_AUTO_MODE_PATCH.optional(),
  })
  .strict();
export type DeploymentSettingsPatch = z.infer<typeof DEPLOYMENT_SETTINGS_PATCH>;

/**
 * 读某个组织的沙箱限额覆盖（创建沙箱、组织设置页用）；每次实时读 PG，多副本下改动立即生效。
 * 只解析这个组织的那一条：没有设置、组织不在其中、或这一条存量值非法 → undefined；别的组织的条目非法不影响它。
 */
export async function readSandboxLimitOverride(
  db: KernelSchemaDb,
  orgId: string,
): Promise<SandboxLimitOverride | undefined> {
  const row = await db
    .selectFrom("deployment_settings")
    .select("value")
    .where("key", "=", "sandboxLimitOverrides")
    .executeTakeFirst();
  if (!row) return undefined;
  const all = row.value;
  if (typeof all !== "object" || all === null || Array.isArray(all) || !Object.hasOwn(all, orgId)) {
    return undefined;
  }
  const parsed = SANDBOX_LIMIT_OVERRIDE.safeParse((all as Record<string, unknown>)[orgId]);
  return parsed.success ? parsed.data : undefined;
}

/**
 * One organization's sub-agent limit override, read live from PG (so a change applies on every
 * replica at once); in the caller's transaction when one is given. Only this organization's entry
 * is parsed: no setting, no entry, or an invalid stored entry → undefined.
 */
export async function readSubagentLimitOverride(
  db: KernelSchemaDb,
  orgId: string,
): Promise<SubagentLimitOverride | undefined> {
  const row = await db
    .selectFrom("deployment_settings")
    .select("value")
    .where("key", "=", "subagentLimitOverrides")
    .executeTakeFirst();
  if (!row) return undefined;
  const all = row.value;
  if (typeof all !== "object" || all === null || Array.isArray(all) || !Object.hasOwn(all, orgId)) {
    return undefined;
  }
  const parsed = SUBAGENT_LIMIT_OVERRIDE.safeParse((all as Record<string, unknown>)[orgId]);
  return parsed.success ? parsed.data : undefined;
}

/**
 * When orgs may not create their own connectors / skills (deployment setting `customConnectors` /
 * `customSkills` is `deny`, C22) throws `catalog.custom_disabled`: install from the platform
 * catalog only. Reads PG live every time (can read in the caller's transaction); an invalid stored
 * value counts as allow.
 */
export async function assertCustomAllowed(
  db: KernelSchemaDb,
  key: "customConnectors" | "customSkills",
): Promise<void> {
  const row = await db
    .selectFrom("deployment_settings")
    .select("value")
    .where("key", "=", key)
    .executeTakeFirst();
  if (!row) return;
  const parsed = CustomPolicy.safeParse(row.value);
  if (parsed.success && parsed.data === "deny") {
    throw new ApiError(
      "catalog.custom_disabled",
      key === "customConnectors"
        ? "Custom connectors are disabled in this deployment; install connectors from the platform catalog"
        : "Custom skills are disabled in this deployment; install skills from the platform catalog",
    );
  }
}

/**
 * The deployment setting `orgMarketplaceBrowse`, read live from PG (in the caller's transaction
 * when there is one); missing or invalid -> the default, true.
 */
export async function readOrgMarketplaceBrowse(db: KernelSchemaDb): Promise<boolean> {
  const row = await db
    .selectFrom("deployment_settings")
    .select("value")
    .where("key", "=", "orgMarketplaceBrowse")
    .executeTakeFirst();
  if (!row) return true;
  const parsed = z.boolean().safeParse(row.value);
  return parsed.success ? parsed.data : true;
}

/**
 * The platform default theme setting, read live from PG (in the caller's transaction when there is
 * one) and parsed with {@link UiThemeSetting}: missing or invalid -> `{ id: null }`. `lock`: the
 * row is read FOR SHARE, so a concurrent write of the setting (which holds it FOR UPDATE) waits for
 * the caller's transaction, and the reverse.
 */
export async function readUiTheme(
  db: KernelSchemaDb,
  opts: { lock?: boolean } = {},
): Promise<UiTheme> {
  let q = db.selectFrom("deployment_settings").select("value").where("key", "=", UI_THEME_SETTING);
  if (opts.lock) q = q.forShare();
  const row = await q.executeTakeFirst();
  const parsed = UiThemeSetting.safeParse(row?.value);
  return parsed.success ? parsed.data : { id: null };
}

/**
 * Locks the `uiTheme` row FOR UPDATE in the caller's transaction, creating it as `{ id: null }`
 * first when it is missing (migration 0094 seeds it; a test may have truncated the table), so the
 * FOR SHARE readers always find a row to wait on.
 */
async function lockUiThemeRow(db: KernelSchemaDb): Promise<void> {
  await db
    .insertInto("deployment_settings")
    .values({ key: UI_THEME_SETTING, value: JSON.stringify({ id: null }) })
    .onConflict((oc) => oc.column("key").doNothing())
    .execute();
  await db
    .selectFrom("deployment_settings")
    .select("key")
    .where("key", "=", UI_THEME_SETTING)
    .forUpdate()
    .execute();
}

/**
 * The platform default arrangement of UI slots, read live (the lists apply it). An invalid
 * stored value reads as `{}` (the same fallback {@link SettingsService.get} uses).
 */
export async function readUiArrangement(db: KernelSchemaDb): Promise<UiArrangement> {
  const row = await db
    .selectFrom("deployment_settings")
    .select("value")
    .where("key", "=", "uiArrangement")
    .executeTakeFirst();
  const parsed = UiArrangementSchema.safeParse(row?.value);
  return parsed.success ? parsed.data : {};
}

/**
 * The client code kill switch, read live from PG on every request (in the caller's transaction when
 * there is one; never cached: every replica sees a change at once), through
 * {@link parseClientExtensions} (missing or invalid -> everything on; invalid also warns on `log`).
 */
export async function readClientExtensions(
  db: KernelSchemaDb,
  log?: Pick<KernelLogger, "warn">,
): Promise<ClientExtensionsKillSwitch> {
  const row = await db
    .selectFrom("deployment_settings")
    .select("value")
    .where("key", "=", CLIENT_EXTENSIONS_SETTING)
    .executeTakeFirst();
  return parseClientExtensions(row?.value, log);
}

/** 按组织合并覆盖：值为 null 删除该组织，其余整项替换；未列出的组织不变。 */
function mergeByOrg<T>(
  current: Record<string, T>,
  patch: Record<string, T | null>,
): Record<string, T> {
  const merged = { ...current };
  for (const [orgId, value] of Object.entries(patch)) {
    if (value === null) delete merged[orgId];
    else merged[orgId] = value;
  }
  return merged;
}

/** Deployment settings: one row per key, defaults for missing keys. */
@Injectable()
export class SettingsService {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(SuperAdminLock) private readonly adminLock: SuperAdminLock,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<KernelLogger, "warn">,
    /** The startup config's `devices.autoMode`, which wins over the stored choice. */
    @Inject(KernelConfigService)
    private readonly config: Pick<KernelConfigService, "get" | "fieldSource">,
  ) {}

  /** The settings with the platform's auto-mode switch in effect and where it comes from. */
  async view(): Promise<DeploymentSettingsView> {
    const [settings, devicesAutoMode] = await Promise.all([
      this.get(),
      readDevicesAutoMode(this.db.db, this.config, this.log),
    ]);
    return { ...settings, devicesAutoMode };
  }

  /**
   * The refusals of a `devicesAutoMode` change: a value set in the startup config
   * (`deployment.setting_readonly`) and, with `onlyNarrows` (an API token, the Platform tool),
   * turning auto mode on where it is off (`deployment.auto_mode_not_allowed`). Returns the next
   * stored choice and the effective switch before it.
   */
  async checkDevicesAutoMode(
    patch: DevicesAutoModePatch,
    opts: { onlyNarrows?: boolean } = {},
  ): Promise<{ next: DevicesAutoModeStored; before: DevicesAutoModeView }> {
    const source = this.config.fieldSource("devices.autoMode");
    if (source !== undefined) {
      throw new ApiError(
        "deployment.setting_readonly",
        "The platform's auto-mode switch is set in the startup config (file, Nacos or environment) and is read-only here",
        [{ path: "devicesAutoMode.mode", source }],
      );
    }
    const before = await readDevicesAutoMode(this.db.db, this.config, this.log);
    const next = applyDevicesAutoModePatch(
      await readStoredDevicesAutoMode(this.db.db, this.log),
      patch,
    );
    const after = next.mode ?? "allowed";
    if (opts.onlyNarrows && before.mode === "off" && after === "allowed") {
      throw autoModeWidenRefused();
    }
    return { next, before };
  }

  /**
   * Reads every setting, in the context's transaction when there is one (a caller holding a
   * transaction connection does not take a second one from the pool). Each key is validated on
   * its own: an invalid stored value falls back to the default with a warning naming the key, the
   * valid keys apply; unknown keys (written by a newer version) are ignored.
   */
  async get(): Promise<DeploymentSettings> {
    const rows = await this.db.selectFrom("deployment_settings").select(["key", "value"]).execute();
    const stored = new Map(rows.map((r) => [r.key, r.value as unknown]));
    const out: Record<string, unknown> = { ...DEFAULTS };
    for (const [key, field] of Object.entries(DEPLOYMENT_SETTINGS.shape)) {
      if (!stored.has(key)) continue;
      const parsed = field.safeParse(stored.get(key));
      if (parsed.success) {
        out[key] = parsed.data;
      } else {
        this.log.warn("invalid deployment setting; using default", {
          key,
          issues: parsed.error.issues.map((i) => i.message),
        });
      }
    }
    return out as DeploymentSettings;
  }

  /**
   * Updates settings under the super admin lock, re-checking the actor (else `forbidden`).
   * `onlyNarrows` (an API token, the Platform tool): `devicesAutoMode` may only turn auto mode off.
   */
  async update(
    patch: DeploymentSettingsPatch,
    actorAccountId: string,
    actorTokenId?: string,
    /** Merged into the audit detail (the Platform tool's `via: "agent"`). */
    auditDetail?: Record<string, unknown>,
    opts: { onlyNarrows?: boolean } = {},
  ): Promise<DeploymentSettingsView> {
    const check = DEPLOYMENT_SETTINGS_PATCH.safeParse(patch);
    if (!check.success) {
      throw new ApiError(
        "validation_failed",
        "Invalid deployment settings",
        check.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      );
    }
    await this.write(check.data, actorAccountId, actorTokenId, auditDetail, opts);
    return this.view();
  }

  @Transactional()
  private async write(
    patch: DeploymentSettingsPatch,
    actorAccountId: string,
    actorTokenId: string | undefined,
    auditDetail: Record<string, unknown> | undefined,
    opts: { onlyNarrows?: boolean },
  ): Promise<void> {
    await this.adminLock.lockAndAuthorize(actorAccountId);
    // The super admin lock serializes every settings write: the current overrides are read
    // and merged under it, so no concurrent change is lost
    const next: Partial<DeploymentSettings> = {};
    if (patch.orgCreation !== undefined) next.orgCreation = patch.orgCreation;
    if (patch.priceCurrency !== undefined) next.priceCurrency = patch.priceCurrency;
    if (patch.customConnectors !== undefined) next.customConnectors = patch.customConnectors;
    if (patch.customSkills !== undefined) next.customSkills = patch.customSkills;
    if (patch.orgMarketplaceBrowse !== undefined) {
      next.orgMarketplaceBrowse = patch.orgMarketplaceBrowse;
    }
    if (patch.uiTheme !== undefined) {
      // The one theme lock order (themes spec §7), inside the super admin lock above: the chosen
      // theme's catalog item, then its `platform_themes` row FOR SHARE, then the `uiTheme` row FOR
      // UPDATE, and only then the eligibility check (on in every live org). The writers that take
      // a theme away or switch it off in an org (scope, disable, removal, the org switch and
      // uninstall) hold the item or theme row before they read `uiTheme` FOR SHARE, so they and
      // this write wait for each other in the same order and never deadlock.
      if (patch.uiTheme.id !== null) await lockThemeShared(this.db.db, patch.uiTheme.id);
      await lockUiThemeRow(this.db.db);
      if (patch.uiTheme.id !== null) {
        await assertPlatformDefaultEligible(this.db.db, patch.uiTheme.id);
      }
      next.uiTheme = { id: patch.uiTheme.id };
    }
    const {
      runConcurrencyOverrides: runPatch,
      sandboxLimitOverrides: sandboxPatch,
      subagentLimitOverrides: subagentPatch,
      uiArrangement: arrangementPatch,
      clientExtensions: clientPatch,
    } = patch;
    if (
      runPatch !== undefined ||
      sandboxPatch !== undefined ||
      subagentPatch !== undefined ||
      arrangementPatch !== undefined ||
      clientPatch !== undefined
    ) {
      const current = await this.get();
      if (clientPatch !== undefined) {
        next.clientExtensions = {
          enabled: clientPatch.enabled ?? current.clientExtensions.enabled,
          disabled:
            clientPatch.disabled === undefined
              ? current.clientExtensions.disabled
              : [...new Set(clientPatch.disabled)].sort(),
        };
      }
      if (arrangementPatch !== undefined) {
        next.uiArrangement = mergeArrangement(current.uiArrangement, arrangementPatch);
      }
      if (runPatch !== undefined) {
        next.runConcurrencyOverrides = mergeByOrg(current.runConcurrencyOverrides, runPatch);
      }
      if (sandboxPatch !== undefined) {
        next.sandboxLimitOverrides = mergeByOrg(current.sandboxLimitOverrides, sandboxPatch);
      }
      if (subagentPatch !== undefined) {
        next.subagentLimitOverrides = mergeByOrg(current.subagentLimitOverrides, subagentPatch);
      }
    }
    // the platform's auto-mode switch: checked against the stored choice under the lock; the
    // stored shape keeps `mode` optional, so clearing it (null) writes `{}` back to the default
    let autoModeChange: { before: DevicesAutoModeView; after: DevicesAutoMode } | undefined;
    const writes: [string, unknown][] = Object.entries(next);
    if (patch.devicesAutoMode !== undefined) {
      const r = await this.checkDevicesAutoMode(patch.devicesAutoMode, opts);
      autoModeChange = { before: r.before, after: r.next.mode ?? "allowed" };
      writes.push([DEVICES_AUTO_MODE_SETTING, r.next]);
    }
    for (const [key, value] of writes) {
      if (value === undefined) continue;
      const json = JSON.stringify(value);
      await this.db
        .insertInto("deployment_settings")
        .values({ key, value: json, updated_by: actorAccountId })
        .onConflict((oc) =>
          oc
            .column("key")
            .doUpdateSet({ value: json, updated_by: actorAccountId, updated_at: new Date() }),
        )
        .execute();
    }
    await audit(this.db.db, {
      actorAccountId,
      ...(actorTokenId !== undefined && { actorTokenId }),
      action: "deployment.settings.updated",
      detail: {
        ...patch,
        ...(autoModeChange !== undefined && { devicesAutoModeEffective: autoModeChange }),
        ...auditDetail,
      },
    });
  }
}
