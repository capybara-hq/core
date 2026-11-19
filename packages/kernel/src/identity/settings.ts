import { EXTENSION_NAME_RE } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import {
  applyPlatformAttributionPatch,
  PLATFORM_ATTRIBUTION_FIELDS,
  PLATFORM_ATTRIBUTION_PATCH,
  PLATFORM_ATTRIBUTION_SETTING,
  type PlatformAttributionPatch,
  type PlatformAttributionSource,
  type PlatformAttributionStored,
  type PlatformAttributionView,
  readStoredPlatformAttribution,
  resolvePlatformAttribution,
} from "../attribution/platform-attribution.js";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost, withOrderedLocks } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import {
  applyDevicesNetworkPatch,
  applyDevicesOutsideSandboxPatch,
  configuredDeviceSandbox,
  DEVICES_NETWORK_PATCH,
  DEVICES_NETWORK_SETTING,
  DEVICES_OUTSIDE_SANDBOX_PATCH,
  DEVICES_OUTSIDE_SANDBOX_SETTING,
  type DeviceSandboxSettingsView,
  type DevicesNetworkPatch,
  type DevicesNetworkStored,
  type DevicesNetworkView,
  type DevicesOutsideSandboxPatch,
  type DevicesOutsideSandboxStored,
  type DevicesOutsideSandboxView,
  legacyPermissionFor,
  legacyPlatformKeysStored,
  legacyPlatformValue,
  readDeviceSandboxSettingsView,
  readStoredDeviceSandbox,
  resolveDeviceSandboxSettings,
} from "../sandbox/device-sandbox-settings.js";
import {
  localMachineRoots,
  needsOpenNetwork,
  needsWiderDeviceCeiling,
  PermissionCeilingWrites,
} from "../sandbox/permission-ceiling-writes.js";
import {
  EXTERNAL_SHARING_SETTING,
  ExternalSharingValue,
  type ExternalSharingView,
  HTML_CDN_ALLOWLIST_DEFAULT,
  HtmlCdnAllowlistSchema,
  readExternalSharing,
  readHtmlCdnAllowlist,
  readShareMaxExpiry,
  SHARE_MAX_EXPIRY_DEFAULT,
  SHARE_MAX_EXPIRY_SETTING,
  ShareMaxExpiryDays,
  type ShareMaxExpiryView,
} from "../shares/settings.js";
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

/**
 * The compaction field schemas and their bounds, before defaults: the partial form below shares
 * them, so a patch validates the same ranges as a stored value without filling defaults for the
 * fields it leaves out.
 */
const COMPACTION_FIELDS = {
  enabled: z.boolean(),
  threshold: z.number().min(0.5).max(0.95),
  keepRecentTurns: z.number().int().min(0).max(20),
  reserveTokens: z.number().int().min(0).max(50_000),
  maxOutputTokens: z.number().int().min(1024).max(32_000),
};

/**
 * Conversation compaction (context compaction spec §4.8): the platform's defaults and the bounds
 * every organization's override is validated against. `enabled: false` turns proactive early
 * compaction off; the hard line, hard fit guard and reactive path stay armed. `reserveTokens` is
 * the safety margin left below the window, `maxOutputTokens` the summary call's output cap.
 */
export const COMPACTION_SETTINGS = z.object({
  enabled: COMPACTION_FIELDS.enabled.default(true),
  threshold: COMPACTION_FIELDS.threshold.default(0.8),
  keepRecentTurns: COMPACTION_FIELDS.keepRecentTurns.default(4),
  reserveTokens: COMPACTION_FIELDS.reserveTokens.default(8000),
  maxOutputTokens: COMPACTION_FIELDS.maxOutputTokens.default(20_000),
});

export type CompactionSettings = z.infer<typeof COMPACTION_SETTINGS>;

/**
 * The partial form the platform and org patches carry: only the given fields, validated against
 * the same bounds, so merging them into the stored settings never injects a default for a field
 * the caller left out.
 */
export const COMPACTION_SETTINGS_PARTIAL = z.object(COMPACTION_FIELDS).partial();

/**
 * The patch form both settings writers take: the partial form above, strict, so a misspelled
 * field (`treshold`) is a 400 instead of being silently stripped into an empty no-op. Stored
 * values stay lenient ({@link COMPACTION_SETTINGS_PARTIAL}); only the request bodies are strict.
 */
export const COMPACTION_SETTINGS_PATCH = COMPACTION_SETTINGS_PARTIAL.strict();

export type CompactionSettingsPatch = z.infer<typeof COMPACTION_SETTINGS_PARTIAL>;

/**
 * The compaction settings in effect for an organization (spec §4.8): every field the org gives wins,
 * the rest follow the platform's settings, which are themselves the built-in defaults when unset.
 */
export function effectiveCompactionSettings(
  platform: CompactionSettings,
  org: CompactionSettingsPatch | undefined,
): CompactionSettings {
  return {
    enabled: org?.enabled ?? platform.enabled,
    threshold: org?.threshold ?? platform.threshold,
    keepRecentTurns: org?.keepRecentTurns ?? platform.keepRecentTurns,
    reserveTokens: org?.reserveTokens ?? platform.reserveTokens,
    maxOutputTokens: org?.maxOutputTokens ?? platform.maxOutputTokens,
  };
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
  /**
   * Conversation compaction (context compaction spec §4.8): the platform defaults, with the built-in
   * values; an organization may override any field in its own settings.
   */
  compaction: COMPACTION_SETTINGS.prefault({}),
  /**
   * The CDN origins a rendered HTML file may load scripts, styles, fonts and images from (file
   * sharing spec §4): `https://` origins only; applies to the next document load. No org level.
   */
  htmlRenderCdnAllowlist: HtmlCdnAllowlistSchema.default(() => [...HTML_CDN_ALLOWLIST_DEFAULT]),
});
export type DeploymentSettings = z.infer<typeof DEPLOYMENT_SETTINGS>;

const DEFAULTS: DeploymentSettings = DEPLOYMENT_SETTINGS.parse({});

/**
 * What `GET /api/v1/admin/settings` answers: the stored settings, the platform's device sandbox
 * settings as they are in effect with where each comes from (`env` / `file` / `nacos`: the startup
 * config, read-only here; `db`: chosen in the admin console; `default`), and the platform's
 * effective attribution defaults with their sources the same way.
 */
export type DeploymentSettingsView = DeploymentSettings & {
  /** Whether a device may be granted running a call outside its sandbox. */
  devicesOutsideSandbox: DevicesOutsideSandboxView;
  /** The sandbox network's default and ceiling (the default never above the ceiling). */
  devicesNetwork: DevicesNetworkView;
  attribution: PlatformAttributionView;
  /** The platform's external sharing switch in effect and where it comes from. */
  externalSharing: ExternalSharingView;
  /** The longest expiry a share may take, in days, and where it comes from. */
  shareMaxExpiryDays: ShareMaxExpiryView;
  /** The platform's prompt suggestions switch (absent reads `on`). */
  promptSuggestions: "on" | "off";
};

const outsideSandboxWidenRefused = (): ApiError =>
  new ApiError(
    "deployment.outside_sandbox_not_allowed",
    "Allowing devices to run outside the sandbox at the platform level (devicesOutsideSandbox) needs a super admin in the admin console; an API token or the Platform tool may only turn it off.",
  );

const networkNotAllowed = (message: string, field: "default" | "ceiling"): ApiError =>
  new ApiError("deployment.network_not_allowed", message, [{ path: `devicesNetwork.${field}` }]);

/** The `deployment_settings` key of the platform's prompt suggestions switch (`"on" | "off"`). */
export const PROMPT_SUGGESTIONS_SETTING = "promptSuggestions";

const PromptSuggestionsValue = z.enum(["on", "off"]);

/**
 * The platform's prompt suggestions switch, read live from PG (in the caller's transaction when
 * there is one): absent is `on`; an invalid stored value reads as `off` with a warning.
 */
export async function readPromptSuggestions(
  db: KernelSchemaDb,
  log?: Pick<KernelLogger, "warn">,
): Promise<"on" | "off"> {
  const row = await db
    .selectFrom("deployment_settings")
    .select("value")
    .where("key", "=", PROMPT_SUGGESTIONS_SETTING)
    .executeTakeFirst();
  if (row === undefined) return "on";
  const parsed = PromptSuggestionsValue.safeParse(row.value);
  if (parsed.success) return parsed.data;
  log?.warn("invalid deployment setting; it reads as prompt suggestions off", {
    key: PROMPT_SUGGESTIONS_SETTING,
  });
  return "off";
}

const externalSharingWidenRefused = (): ApiError =>
  new ApiError(
    "deployment.external_sharing_not_allowed",
    "Allowing external sharing at the platform level (externalSharing) needs a super admin in the admin console; an API token or the Platform tool may only turn it off.",
  );

const sharingWidenRefused = (field: string, message: string): ApiError =>
  new ApiError("deployment.sharing_widen_not_allowed", message, [{ path: field }]);

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
     * The platform's outside-sandbox ceiling: `permission` replaced, null clears it (back to the
     * default, allowed). A value set in the startup config is read-only (409
     * `deployment.setting_readonly`); an API token or the Platform tool may only turn it off (400
     * `deployment.outside_sandbox_not_allowed`).
     */
    devicesOutsideSandbox: DEVICES_OUTSIDE_SANDBOX_PATCH.optional(),
    /**
     * The platform's sandbox network: each given field replaces the stored one, null clears it
     * (back to the default, open). A default above the ceiling, or (an API token or the Platform
     * tool) any widening is refused (400 `deployment.network_not_allowed`); a field set in the
     * startup config is read-only (409 `deployment.setting_readonly`).
     */
    devicesNetwork: DEVICES_NETWORK_PATCH.optional(),
    /**
     * The platform's attribution defaults for agent-created git commits and pull requests (spec
     * 2026-11-14-agent-attribution): each given field replaces the stored one, null clears it
     * (back to the default), `""` turns that line off. A field set in the startup config is
     * read-only (409 `deployment.setting_readonly`).
     */
    attribution: PLATFORM_ATTRIBUTION_PATCH.optional(),
    /**
     * Conversation compaction (context compaction spec §4.8): each given field replaces the stored
     * one, fields left out keep their value.
     */
    compaction: COMPACTION_SETTINGS_PATCH.optional(),
    /**
     * The platform's external sharing switch (file sharing spec §8): allow or deny; null clears it
     * (back to the default, deny). A value set in the startup config is read-only (409
     * `deployment.setting_readonly`); an API token or the Platform tool may only turn it off (400
     * `deployment.external_sharing_not_allowed`).
     */
    externalSharing: ExternalSharingValue.nullable().optional(),
    /**
     * The longest expiry a share may take, in days (1 to 365); null clears it (back to 30). A
     * value set in the startup config is read-only (409 `deployment.setting_readonly`).
     */
    shareMaxExpiryDays: ShareMaxExpiryDays.nullable().optional(),
    /**
     * Whether the composer suggests the person's next message after a completed run, for the whole
     * platform; null clears it (back to the default, on). An org's own switch must be on too.
     */
    promptSuggestions: PromptSuggestionsValue.nullable().optional(),
    /** The CDN allowlist of rendered HTML files, replaced whole (stored without duplicates). */
    htmlRenderCdnAllowlist: HtmlCdnAllowlistSchema.optional(),
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
 * The platform's conversation compaction settings, read live from PG (the org settings page shows
 * what an organization that follows the platform gets): missing or invalid -> the built-in
 * defaults, as {@link SettingsService.get} reads them.
 */
export async function readPlatformCompactionSettings(
  db: KernelSchemaDb,
): Promise<CompactionSettings> {
  const row = await db
    .selectFrom("deployment_settings")
    .select("value")
    .where("key", "=", "compaction")
    .executeTakeFirst();
  const parsed = COMPACTION_SETTINGS.safeParse(row?.value ?? {});
  return parsed.success ? parsed.data : DEFAULTS.compaction;
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
    /** The startup config's `devices.outsideSandbox` / `devices.network.*`, which win over the stored choice. */
    @Inject(KernelConfigService)
    private readonly config: Pick<KernelConfigService, "get" | "fieldSource">,
    @Inject(PermissionCeilingWrites) private readonly ceilings: PermissionCeilingWrites,
  ) {}

  /** The settings with the platform's device sandbox settings and attribution defaults in effect. */
  async view(): Promise<DeploymentSettingsView> {
    const [
      settings,
      deviceSandbox,
      attribution,
      externalSharing,
      shareMaxExpiryDays,
      promptSuggestions,
    ] = await Promise.all([
      this.get(),
      readDeviceSandboxSettingsView(this.db.db, this.config, this.log),
      readStoredPlatformAttribution(this.db.db, this.log),
      readExternalSharing(this.db.db, this.config, this.log),
      readShareMaxExpiry(this.db.db, this.config, this.log),
      readPromptSuggestions(this.db.db, this.log),
    ]);
    return {
      ...settings,
      devicesOutsideSandbox: deviceSandbox.outsideSandbox,
      devicesNetwork: deviceSandbox.network,
      attribution: this.attributionView(attribution),
      externalSharing,
      shareMaxExpiryDays,
      promptSuggestions,
    };
  }

  private attributionView(stored: PlatformAttributionStored): PlatformAttributionView {
    const config = this.config.get().attribution;
    const sources = Object.fromEntries(
      PLATFORM_ATTRIBUTION_FIELDS.map((f): [string, PlatformAttributionSource] => [
        f,
        this.config.fieldSource(`attribution.${f}`) ?? (stored[f] !== undefined ? "db" : "default"),
      ]),
    ) as PlatformAttributionView["sources"];
    return { ...resolvePlatformAttribution(config, stored), sources };
  }

  /**
   * The refusals of a `devicesOutsideSandbox` / `devicesNetwork` change against the stored choice
   * and the startup config: a field set in the startup config (`deployment.setting_readonly`); a
   * network default above the effective ceiling (`deployment.network_not_allowed`); and, with
   * `onlyNarrows` (an API token, the Platform tool), any widening: allowing outside-sandbox runs
   * where it is off (`deployment.outside_sandbox_not_allowed`; clearing it goes back to the default
   * allowed, a widening too) or a network default or ceiling opened where it is the allowlist
   * (`deployment.network_not_allowed`). Returns the next stored choices and the effective view
   * before and after.
   */
  async checkDeviceSandbox(
    patch: {
      devicesOutsideSandbox?: DevicesOutsideSandboxPatch | undefined;
      devicesNetwork?: DevicesNetworkPatch | undefined;
    },
    opts: { onlyNarrows?: boolean } = {},
  ): Promise<{
    next: { outsideSandbox: DevicesOutsideSandboxStored; network: DevicesNetworkStored };
    before: DeviceSandboxSettingsView;
    after: DeviceSandboxSettingsView;
  }> {
    const configured = configuredDeviceSandbox(this.config);
    const readonly = [
      [
        "devicesOutsideSandbox.permission",
        patch.devicesOutsideSandbox !== undefined,
        configured.sources.outsideSandbox,
      ],
      [
        "devicesNetwork.default",
        patch.devicesNetwork?.default !== undefined,
        configured.sources.networkDefault,
      ],
      [
        "devicesNetwork.ceiling",
        patch.devicesNetwork?.ceiling !== undefined,
        configured.sources.networkCeiling,
      ],
    ] as const;
    const fixed = readonly.filter(([, given, source]) => given && source !== undefined);
    if (fixed.length > 0) {
      throw new ApiError(
        "deployment.setting_readonly",
        `These device sandbox settings are set in the startup config (file, Nacos or environment) and are read-only here: ${fixed.map(([path]) => path).join(", ")}`,
        fixed.map(([path, , source]) => ({ path, source })),
      );
    }
    const configuredCeiling =
      configured.sources.networkCeiling !== undefined ? configured.networkCeiling : undefined;
    const stored = await readStoredDeviceSandbox(this.db.db, this.log, configuredCeiling);
    const next = {
      outsideSandbox:
        patch.devicesOutsideSandbox === undefined
          ? stored.outsideSandbox
          : applyDevicesOutsideSandboxPatch(stored.outsideSandbox, patch.devicesOutsideSandbox),
      network:
        patch.devicesNetwork === undefined
          ? stored.network
          : applyDevicesNetworkPatch(stored.network, patch.devicesNetwork),
    };
    const before = resolveDeviceSandboxSettings(configured, stored);
    const after = resolveDeviceSandboxSettings(configured, next);
    // opening the stored default above the stored ceiling (one source) is refused; across
    // sources, and for a change that only narrows, the reader clamps the default to the ceiling
    if (patch.devicesNetwork?.default === "open" && next.network.ceiling === "allowlist")
      throw networkNotAllowed(
        "The network default open is above the ceiling allowlist; set the default to allowlist too, or open the ceiling",
        "default",
      );
    if (opts.onlyNarrows) {
      if (
        patch.devicesOutsideSandbox !== undefined &&
        before.outsideSandbox.permission === "off" &&
        after.outsideSandbox.permission === "allowed"
      )
        throw outsideSandboxWidenRefused();
      for (const field of ["default", "ceiling"] as const) {
        if (patch.devicesNetwork?.[field] === undefined) continue;
        // both the stored choice (it takes effect when the startup config lets it) and the
        // effective value (it may follow the default) must not open
        const storedWidens =
          (stored.network[field] ?? "open") === "allowlist" &&
          (next.network[field] ?? "open") === "open";
        const effectiveWidens =
          before.network[field] === "allowlist" && after.network[field] === "open";
        if (storedWidens || effectiveWidens)
          throw networkNotAllowed(
            `Opening the platform's network ${field} needs a super admin in the admin console; an API token or the Platform tool may only narrow it to the allowlist.`,
            field,
          );
      }
    }
    return { next, before, after };
  }

  /**
   * The refusals of an `externalSharing` / `shareMaxExpiryDays` / `htmlRenderCdnAllowlist` change:
   * a field set in the startup config (`deployment.setting_readonly`) and, with `onlyNarrows` (an
   * API token, the Platform tool), any widening: allowing external sharing where it is denied
   * (`deployment.external_sharing_not_allowed`; clearing it goes back to deny, a narrowing), an
   * expiry maximum above the effective one (null counts as the default, 30) or an allowlist origin
   * the effective list does not hold (`deployment.sharing_widen_not_allowed`). Only a person widens.
   */
  async checkSharing(
    patch: Pick<
      DeploymentSettingsPatch,
      "externalSharing" | "shareMaxExpiryDays" | "htmlRenderCdnAllowlist"
    >,
    opts: { onlyNarrows?: boolean } = {},
  ): Promise<void> {
    const fields = [
      ["externalSharing", "sharing.external"],
      ["shareMaxExpiryDays", "sharing.maxExpiryDays"],
    ] as const;
    const readonly = fields.filter(
      ([key, path]) => patch[key] !== undefined && this.config.fieldSource(path) !== undefined,
    );
    if (readonly.length > 0) {
      throw new ApiError(
        "deployment.setting_readonly",
        `These sharing settings are set in the startup config (file, Nacos or environment) and are read-only here: ${readonly.map(([key]) => key).join(", ")}`,
        readonly.map(([key, path]) => ({ path: key, source: this.config.fieldSource(path) })),
      );
    }
    if (opts.onlyNarrows && patch.externalSharing === "allow") {
      const before = await readExternalSharing(this.db.db, this.config, this.log);
      if (before.value !== "allow") throw externalSharingWidenRefused();
    }
    if (opts.onlyNarrows && patch.shareMaxExpiryDays !== undefined) {
      const before = await readShareMaxExpiry(this.db.db, this.config, this.log);
      const after = patch.shareMaxExpiryDays ?? SHARE_MAX_EXPIRY_DEFAULT;
      if (after > before.value)
        throw sharingWidenRefused(
          "shareMaxExpiryDays",
          `Raising the share expiry maximum (now ${before.value} days) needs a super admin in the admin console; an API token or the Platform tool may only lower it.`,
        );
    }
    if (opts.onlyNarrows && patch.htmlRenderCdnAllowlist !== undefined) {
      // both sides are lower-cased by the schema; a Set compares them without duplicates
      const current = new Set(await readHtmlCdnAllowlist(this.db.db, this.log));
      const added = [...new Set(patch.htmlRenderCdnAllowlist)].filter((o) => !current.has(o));
      if (added.length > 0)
        throw sharingWidenRefused(
          "htmlRenderCdnAllowlist",
          `Adding origins to the HTML CDN allowlist (${added.join(", ")}) needs a super admin in the admin console; an API token or the Platform tool may only remove origins.`,
        );
    }
  }

  /**
   * The refusals of an `attribution` change against the stored choice: a field set in the startup
   * config (`deployment.setting_readonly`). Returns the next stored choice.
   */
  async checkAttribution(patch: PlatformAttributionPatch): Promise<PlatformAttributionStored> {
    const readonly = PLATFORM_ATTRIBUTION_FIELDS.filter(
      (f) => patch[f] !== undefined && this.config.fieldSource(`attribution.${f}`) !== undefined,
    );
    if (readonly.length > 0) {
      throw new ApiError(
        "deployment.setting_readonly",
        `These attribution settings are set in the startup config (file, Nacos or environment) and are read-only here: ${readonly.map((f) => `attribution.${f}`).join(", ")}`,
        readonly.map((f) => ({
          path: `attribution.${f}`,
          source: this.config.fieldSource(`attribution.${f}`),
        })),
      );
    }
    const stored = await readStoredPlatformAttribution(this.db.db, this.log);
    return applyPlatformAttributionPatch(stored, patch);
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
   * `onlyNarrows` (an API token, the Platform tool): `devicesOutsideSandbox` may only turn it off,
   * `devicesNetwork` may only narrow to the allowlist,
   * `externalSharing` may only turn external sharing off, `shareMaxExpiryDays` may only decrease and
   * `htmlRenderCdnAllowlist` may only shrink.
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
    const valid = check.data;
    // the super admin lock, then (for a device sandbox change) the platform permission authority
    // lock: the ordered prelude, so inside a run's fence (the Platform tool's
    // `admin.update-settings`) they precede the conversation rows; the patch decides the lock
    await withOrderedLocks(
      () => this.lockFor(valid, actorAccountId),
      () => this.write(valid, actorAccountId, actorTokenId, auditDetail, opts),
    );
    return this.view();
  }

  @Transactional({ propagation: "mandatory" })
  private async lockFor(patch: DeploymentSettingsPatch, actorAccountId: string): Promise<void> {
    await this.adminLock.lockAndAuthorize(actorAccountId);
    if (patch.devicesOutsideSandbox !== undefined || patch.devicesNetwork !== undefined)
      await this.ceilings.lock({}, "platform");
  }

  @Transactional()
  private async write(
    patch: DeploymentSettingsPatch,
    actorAccountId: string,
    actorTokenId: string | undefined,
    auditDetail: Record<string, unknown> | undefined,
    opts: { onlyNarrows?: boolean },
  ): Promise<void> {
    // held since the prelude (`lockFor`); naming them again re-checks the actor
    await this.lockFor(patch, actorAccountId);
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
    if (patch.htmlRenderCdnAllowlist !== undefined) {
      next.htmlRenderCdnAllowlist = [...new Set(patch.htmlRenderCdnAllowlist)];
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
      compaction: compactionPatch,
    } = patch;
    if (
      runPatch !== undefined ||
      sandboxPatch !== undefined ||
      subagentPatch !== undefined ||
      arrangementPatch !== undefined ||
      clientPatch !== undefined ||
      compactionPatch !== undefined
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
      if (compactionPatch !== undefined) {
        next.compaction = {
          enabled: compactionPatch.enabled ?? current.compaction.enabled,
          threshold: compactionPatch.threshold ?? current.compaction.threshold,
          keepRecentTurns: compactionPatch.keepRecentTurns ?? current.compaction.keepRecentTurns,
          reserveTokens: compactionPatch.reserveTokens ?? current.compaction.reserveTokens,
          maxOutputTokens: compactionPatch.maxOutputTokens ?? current.compaction.maxOutputTokens,
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
    // the platform's device sandbox settings: checked against the stored choices under the lock;
    // the stored shapes keep every field optional, so clearing one (null) writes it out
    let deviceSandboxChange:
      | { before: DeviceSandboxSettingsView; after: DeviceSandboxSettingsView }
      | undefined;
    const writes: [string, unknown][] = Object.entries(next);
    if (patch.devicesOutsideSandbox !== undefined || patch.devicesNetwork !== undefined) {
      const r = await this.checkDeviceSandbox(patch, opts);
      deviceSandboxChange = { before: r.before, after: r.after };
      const legacy = await legacyPlatformKeysStored(this.db.db);
      // old keys the publication conversion has not reached yet (a mismatch window before
      // activation): the new keys are stored as every reader sees them, and each old key is
      // rewritten in step for replicas of the previous version (Full allowed only when running
      // outside the sandbox is allowed and the effective network ceiling is open)
      if (patch.devicesOutsideSandbox !== undefined || legacy.length > 0)
        writes.push([DEVICES_OUTSIDE_SANDBOX_SETTING, r.next.outsideSandbox]);
      if (patch.devicesNetwork !== undefined || legacy.length > 0) {
        if (legacy.length > 0 && Object.keys(r.next.network).length === 0)
          await this.db
            .deleteFrom("deployment_settings")
            .where("key", "=", DEVICES_NETWORK_SETTING)
            .execute();
        else writes.push([DEVICES_NETWORK_SETTING, r.next.network]);
      }
      const inStep = legacyPermissionFor(r.next.outsideSandbox.permission, r.after.network.ceiling);
      for (const key of legacy) writes.push([key, legacyPlatformValue(key, inStep)]);
      const outsideOff =
        r.before.outsideSandbox.permission === "allowed" &&
        r.after.outsideSandbox.permission === "off";
      const outsideChanged =
        r.before.outsideSandbox.permission !== r.after.outsideSandbox.permission;
      const widened = (a: DevicesNetworkView, b: DevicesNetworkView) =>
        (a.ceiling === "allowlist" && b.ceiling === "open") ||
        (a.default === "allowlist" && b.default === "open");
      const networkChanged =
        r.before.network.default !== r.after.network.default ||
        r.before.network.ceiling !== r.after.network.ceiling;
      if (outsideChanged || networkChanged) {
        const machineRoots = outsideOff ? await localMachineRoots(this.db.db) : null;
        // a network ceiling narrowed to the allowlist takes running open-network work
        const networkNarrowed =
          r.before.network.ceiling === "open" && r.after.network.ceiling === "allowlist";
        await this.ceilings.publishLocked(
          {},
          "platform",
          machineRoots === null && !networkNarrowed
            ? false
            : (scope, row) =>
                (networkNarrowed && needsOpenNetwork(scope)) ||
                (machineRoots !== null &&
                  needsWiderDeviceCeiling(scope, machineRoots.get(row.device_id))),
          outsideChanged || widened(r.before.network, r.after.network),
        );
      }
    }
    // the platform's attribution defaults: a field set in the startup config is read-only
    if (patch.attribution !== undefined) {
      writes.push([PLATFORM_ATTRIBUTION_SETTING, await this.checkAttribution(patch.attribution)]);
    }
    // the sharing switches: checked under the lock; null deletes the stored choice (the default)
    const deletes: string[] = [];
    if (
      patch.externalSharing !== undefined ||
      patch.shareMaxExpiryDays !== undefined ||
      patch.htmlRenderCdnAllowlist !== undefined
    ) {
      await this.checkSharing(patch, opts);
      for (const [key, value] of [
        [EXTERNAL_SHARING_SETTING, patch.externalSharing],
        [SHARE_MAX_EXPIRY_SETTING, patch.shareMaxExpiryDays],
      ] as const) {
        if (value === null) deletes.push(key);
        else if (value !== undefined) writes.push([key, value]);
      }
    }
    if (patch.promptSuggestions === null) deletes.push(PROMPT_SUGGESTIONS_SETTING);
    else if (patch.promptSuggestions !== undefined) {
      writes.push([PROMPT_SUGGESTIONS_SETTING, patch.promptSuggestions]);
    }
    if (deletes.length > 0) {
      await this.db.deleteFrom("deployment_settings").where("key", "in", deletes).execute();
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
        ...(deviceSandboxChange !== undefined && { deviceSandboxEffective: deviceSandboxChange }),
        ...auditDetail,
      },
    });
  }
}
