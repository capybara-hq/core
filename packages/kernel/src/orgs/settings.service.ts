import type { SandboxLimits } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable, Module, Optional } from "@nestjs/common";
import { z } from "zod";
import {
  type PlatformAttribution,
  readPlatformAttribution,
} from "../attribution/platform-attribution.js";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { audit } from "../identity/audit.js";
import {
  COMPACTION_SETTINGS_PARTIAL,
  COMPACTION_SETTINGS_PATCH,
  type CompactionSettings,
  readPlatformCompactionSettings,
  readPromptSuggestions,
  readSandboxLimitOverride,
  type SandboxLimitOverride,
} from "../identity/settings.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost, withOrderedLocks } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import type { DeviceNetworkMode } from "../sandbox/device-sandbox.js";
import {
  type DevicesNetworkView,
  type DevicesOutsideSandboxView,
  keepOrgLegacyKeysInStep,
  type OutsideSandboxPermission,
  orgDeviceSandboxOf,
  readDeviceSandboxSettingsView,
} from "../sandbox/device-sandbox-settings.js";
import {
  coversHost,
  orgCloudMode,
  orgEffectiveHosts,
  orgHostOutsideCeiling,
} from "../sandbox/modes.js";
import { isExecutionMethod } from "../sandbox/operation-authority-types.js";
import { PermissionAuthorityModule } from "../sandbox/permission-authority.module.js";
import {
  localMachineRoots,
  needsFullCeiling,
  needsOpenNetwork,
  needsWiderDeviceCeiling,
  PermissionCeilingWrites,
} from "../sandbox/permission-ceiling-writes.js";
import {
  type ExternalSharingView,
  readExternalSharing,
  readShareMaxExpiry,
} from "../shares/settings.js";
import { assertThemeOnIn } from "../themes/theme-state.js";
import { IanaTimeZone } from "../time-zone.js";
import {
  mergeArrangement,
  OrgUiArrangementPatchSchema,
  UiArrangementSchema,
} from "../ui/arrangement.js";
import {
  type DeviceNetworkSetting,
  DeviceNetworkSettingSchema,
  invalidDeviceNetwork,
} from "./device-network-setting.js";
import { OrgLock, OrgLockModule } from "./org-lock.js";

/**
 * Org settings (`capybara.orgs.settings` jsonb). Read leniently: a missing or invalid field reads
 * as its default and unknown keys are kept (merged with the stored value on update), so a new
 * field needs no migration.
 * - `toolSearch`: whether to switch to a catalog + `ToolSearch` once the tools pass the threshold
 *   (D11, default on).
 * - `locale`: the org's default language (`zh` / `en`, default en); the bot's fixed phrases in IM
 *   follow it.
 * - `sandboxToolPolicy`: the default policy of the sandbox tools (M5 T8, default allow). With
 *   `ask`, every tool but the read-only `Read` / `Glob` / `Grep` needs approval (read live at
 *   execution). An invalid stored value reads as `ask` (narrower, never wider) and is logged.
 * - `wakeOnBackgroundTask`: the org's override of `runtime.wakeOnBackgroundTask` (absent follows
 *   the deployment), see {@link effectiveWakeOnBackgroundTask}.
 * - `outsideSandbox`: whether devices of the org may be granted running a call outside their
 *   sandbox (approval-only profiles design, replacing `fullAccess`); absent follows the platform's
 *   `devices.outsideSandbox`, and an invalid stored value reads as `off` (narrower, never wider).
 *   Setting `allowed` while the platform is `off` is refused.
 * - `deviceNetwork`: the org's device sandbox network, its default and ceiling and its hosts as a
 *   delta over the platform's allowlist ({@link DeviceNetworkSettingSchema}, replacing
 *   `cloudNetwork`). An invalid stored value reads as the empty allowlist (narrower, never wider);
 *   a default or ceiling above the platform's ceiling is refused.
 *   Old keys are read and kept in step until the permission configuration publication converts
 *   them ({@link orgDeviceSandboxOf}).
 * - `platformTool`: the `Platform` builtin for the whole org (Platform tool spec §3): `on`,
 *   `read-only` (writes listed as unavailable) or `off` (default `on`).
 * - `timeZone`: the org's default time zone (IANA; absent = UTC) for senders without one of their
 *   own (run context spec §3.3); an invalid stored value reads as absent.
 * - `theme`: the org's default theme and whether members may pick their own (themes spec §7);
 *   absent (or an invalid stored value) = follow the platform, personal picks allowed.
 * - `uiArrangement`: per slot, the extension contributions the org hides and their order (UI slots
 *   spec §5); a slot with no entry follows the platform's; an invalid stored value reads as absent.
 * - `gitGateway`: the org's git gateway switch and host sources (sandbox git credentials spec §9);
 *   not in the PATCH yet; an invalid stored value reads as `{ enabled: false }` (fails closed).
 */

export {
  type DeviceNetworkSetting,
  DeviceNetworkSettingSchema,
  invalidDeviceNetwork,
  ORG_SANDBOX_ALLOW_HOSTS_MAX,
} from "./device-network-setting.js";
/**
 * The org's outside-sandbox ceiling: `allowed` or `off`; absent follows the platform's
 * `devices.outsideSandbox`. An invalid stored value reads as `off` (narrower, never wider).
 */
export const OutsideSandboxSetting = z.enum([
  "allowed",
  "off",
]) satisfies z.ZodType<OutsideSandboxPermission>;

/**
 * The org's theme setting (themes spec §7): `id` a theme on in the org (a `platform_themes` id),
 * null = follow the platform's default; `personal: "locked"` hides the personal picker in the org
 * and resolution ignores personal picks there.
 */
export const OrgThemeSettingSchema = z
  .object({
    id: z.string().min(1).max(200).nullable(),
    personal: z.enum(["allowed", "locked"]),
  })
  .strict();

export type OrgThemeSetting = z.infer<typeof OrgThemeSettingSchema>;

/** The theme setting of an org that has none: follow the platform, personal picks allowed. */
export const DEFAULT_ORG_THEME: OrgThemeSetting = { id: null, personal: "allowed" };

const posInt = (max: number, def: number) =>
  z.number().int().min(1).max(max).default(def).catch(def);

/** A stored `forbiddenTools` entry worth keeping: a tool key of the length the PATCH accepts. */
const isForbiddenToolEntry = (v: unknown): v is string =>
  typeof v === "string" && v.length >= 1 && v.length <= 200;

/**
 * Org settings of scheduled tasks (spec §9); every field reads leniently (invalid = default,
 * except `forbiddenTools`, which keeps its valid entries). A stored `forbiddenTools` that is not a
 * list (or a group that is not an object) reads as `[]` here, for display; enforcement checks
 * {@link invalidStoredForbiddenTools} and fails unattended runs instead (never wider).
 */
export const ScheduledTasksSettingsSchema = z.object({
  enabled: z.boolean().default(true).catch(true),
  minIntervalMinutes: posInt(1_000_000, 60),
  maxTasksPerMember: posInt(1_000_000, 20),
  maxTasksPerOrg: posInt(1_000_000, 200),
  maxRunsPerHour: posInt(1_000_000, 60),
  defaultExpiryDays: z.number().int().min(1).max(36_500).nullable().default(null).catch(null),
  catchUpWindowMinutes: posInt(1_000_000, 60),
  unattendedAsk: z.enum(["fail", "wait"]).default("fail").catch("fail"),
  pauseAfterFailures: posInt(1000, 5),
  // fail-safe: an invalid entry is dropped, the valid ones stay forbidden (never reset to []);
  // past the PATCH's 500 the list is truncated
  forbiddenTools: z
    .preprocess(
      (v) => (Array.isArray(v) ? v.filter(isForbiddenToolEntry).slice(0, 500) : v),
      z.array(z.string()).max(500).default([]),
    )
    .catch([]),
});

export type ScheduledTasksSettings = z.infer<typeof ScheduledTasksSettingsSchema>;

/**
 * The PATCH form: a partial merge into the group (fields left out keep their stored value; see
 * `OrgSettingsService.update`). A field given replaces that field whole, `forbiddenTools` too.
 */
export const ScheduledTasksPatchSchema = z
  .object({
    enabled: z.boolean(),
    minIntervalMinutes: z.number().int().min(1).max(1_000_000),
    maxTasksPerMember: z.number().int().min(1).max(1_000_000),
    maxTasksPerOrg: z.number().int().min(1).max(1_000_000),
    maxRunsPerHour: z.number().int().min(1).max(1_000_000),
    defaultExpiryDays: z.number().int().min(1).max(36_500).nullable(),
    catchUpWindowMinutes: z.number().int().min(1).max(1_000_000),
    unattendedAsk: z.enum(["fail", "wait"]),
    pauseAfterFailures: z.number().int().min(1).max(1000),
    forbiddenTools: z.array(z.string().min(1).max(200)).max(500),
  })
  .partial()
  .strict();

/**
 * The org's git gateway setting (sandbox git credentials spec §9): `enabled: false` switches the
 * gateway off for the org (absent = on); `hostSources` names, per git host, the connector whose
 * credential the gateway uses there. Reads fail closed: an invalid stored value (not an object, or
 * a field of the wrong type) reads as {@link GIT_GATEWAY_INVALID} (off), never wider than stored.
 */
export const GitGatewaySettingSchema = z.object({
  enabled: z.boolean().optional(),
  hostSources: z.record(z.string(), z.string()).optional(),
});

/** What an invalid stored `gitGateway` reads as: the gateway off for the org. */
export const GIT_GATEWAY_INVALID = { enabled: false } as const;

export type GitGatewaySetting = z.infer<typeof GitGatewaySettingSchema>;

const ExternalSharingSetting = z.enum(["on", "off"]);
const PromptSuggestionsSetting = z.enum(["on", "off"]);

/** Whether prompt suggestions run for an org: the platform is on and the org has not turned it off. */
export function effectivePromptSuggestions(
  platform: "on" | "off",
  org: "on" | "off" | undefined,
): boolean {
  return platform === "on" && org !== "off";
}

export const OrgSettingsSchema = z.object({
  toolSearch: z.enum(["on", "off"]).default("on").catch("on"),
  locale: z.enum(["zh", "en"]).default("en").catch("en"),
  /** Absent = `allow`; an invalid stored value reads as `ask` (narrower, never wider). */
  sandboxToolPolicy: z.enum(["allow", "ask"]).default("allow").catch("ask"),
  platformTool: z.enum(["on", "read-only", "off"]).default("on").catch("on"),
  /** The org's outside-sandbox ceiling; absent follows the platform. */
  outsideSandbox: OutsideSandboxSetting.optional().catch("off"),
  /** The org's device sandbox network; absent follows the platform. */
  deviceNetwork: DeviceNetworkSettingSchema.optional().catch(invalidDeviceNetwork),
  /** Overrides `runtime.wakeOnBackgroundTask`; absent follows the deployment. */
  wakeOnBackgroundTask: z.boolean().optional().catch(undefined),
  /** The org's default time zone (run context spec §3.3); absent = UTC. */
  timeZone: IanaTimeZone.optional().catch(undefined),
  /** The org's default theme and personal lock (themes spec §7); absent = {@link DEFAULT_ORG_THEME}. */
  theme: OrgThemeSettingSchema.optional().catch(undefined),
  /** Hidden and ordered extension contributions per slot; absent = follow the platform. */
  uiArrangement: UiArrangementSchema.optional().catch(undefined),
  /** The org's git gateway switch and host sources; absent = on, sources chosen by default. */
  gitGateway: GitGatewaySettingSchema.optional().catch({ ...GIT_GATEWAY_INVALID }),
  /** Scheduled tasks (spec §9); the platform bounds clamp it, see `effectiveScheduleSettings`. */
  scheduledTasks: ScheduledTasksSettingsSchema.prefault({}).catch(
    ScheduledTasksSettingsSchema.parse({}),
  ),
  /**
   * Conversation compaction overrides (context compaction spec §4.8): every field given wins, the
   * rest follow the platform; absent (or an invalid stored value) follows the platform entirely.
   */
  compaction: COMPACTION_SETTINGS_PARTIAL.optional().catch(undefined),
  /**
   * The org's external sharing switch (file sharing spec §8); absent = off. An invalid stored
   * value reads as `off` (never wider). The platform's switch must allow it too.
   */
  externalSharing: ExternalSharingSetting.optional().catch("off"),
  /**
   * The org's prompt suggestions switch; absent follows the platform (on). An invalid stored value
   * reads as `off`. The platform's switch must be on too ({@link effectivePromptSuggestions}).
   */
  promptSuggestions: PromptSuggestionsSetting.optional().catch("off"),
});

export type OrgSettings = z.infer<typeof OrgSettingsSchema>;

/**
 * The settings as the responses carry them: {@link OrgSettings} plus
 * `scheduledTasks.forbiddenToolsUnreadable: true` when the stored list cannot be read
 * ({@link invalidStoredForbiddenTools}; `forbiddenTools` then reads `[]`), so the settings page
 * says so and saves the list. Never stored.
 */
export type OrgSettingsView = OrgSettings & {
  scheduledTasks: OrgSettings["scheduledTasks"] & { forbiddenToolsUnreadable?: true };
};

/** {@link OrgSettingsView} of `settings`, flagged from the stored value `raw`. */
const viewOf = (settings: OrgSettings, raw: unknown): OrgSettingsView =>
  invalidStoredForbiddenTools(raw)
    ? {
        ...settings,
        scheduledTasks: { ...settings.scheduledTasks, forbiddenToolsUnreadable: true },
      }
    : settings;

/** PATCH 体：只改给出的字段；未知字段 → 400。 */
export const OrgSettingsPatchSchema = z
  .object({
    toolSearch: z.enum(["on", "off"]).optional(),
    locale: z.enum(["zh", "en"]).optional(),
    sandboxToolPolicy: z.enum(["allow", "ask"]).optional(),
    platformTool: z.enum(["on", "read-only", "off"]).optional(),
    /** null clears (follow the deployment again). */
    wakeOnBackgroundTask: z.boolean().nullable().optional(),
    /**
     * The org's outside-sandbox ceiling; null clears it (follow the platform). `allowed` while the
     * platform is `off` -> 400 `org.outside_sandbox_not_allowed`.
     */
    outsideSandbox: OutsideSandboxSetting.nullable().optional(),
    /**
     * The org's device sandbox network, replaced whole (fields left out follow the platform); null
     * clears it. A default or ceiling above the platform's ceiling -> 400 `org.network_not_allowed`.
     * Through the Platform tool or an API token it may only narrow.
     */
    deviceNetwork: DeviceNetworkSettingSchema.nullable().optional(),
    /** The org's default time zone (IANA); null clears it (UTC). */
    timeZone: IanaTimeZone.nullable().optional(),
    /**
     * The org's default theme (`id`: a theme on in the org, else 400 `theme.not_available`; null
     * follows the platform) and whether members may pick their own; null clears it.
     */
    theme: OrgThemeSettingSchema.nullable().optional(),
    /**
     * Per slot, the entry to hide / order contributions with (replaces that slot's stored entry);
     * null removes a slot's entry (it follows the platform again). `platform.page` is refused.
     */
    uiArrangement: OrgUiArrangementPatchSchema.optional(),
    /** Fields to change in the scheduled-tasks group; the rest keep their value. */
    scheduledTasks: ScheduledTasksPatchSchema.optional(),
    /**
     * Conversation compaction overrides (context compaction spec §4.8): a partial object merges
     * into the stored fields (absent fields keep their value); null clears the whole override
     * (follow the platform again). Strict: a misspelled field is a 400, not a silent no-op.
     */
    compaction: COMPACTION_SETTINGS_PATCH.nullable().optional(),
    /**
     * The org's external sharing switch; null clears it (off). `on` while the platform denies it
     * -> 400 `org.external_sharing_not_allowed`; through the Platform tool or an API token it may
     * only be turned off (the same code).
     */
    externalSharing: ExternalSharingSetting.nullable().optional(),
    /** The org's prompt suggestions switch (on or off); null clears it (follow the platform). */
    promptSuggestions: PromptSuggestionsSetting.nullable().optional(),
  })
  .strict();

export type OrgSettingsPatch = z.infer<typeof OrgSettingsPatchSchema>;

/** Whether a finished background task wakes an idle conversation: the org's setting, else the deployment's. */
export function effectiveWakeOnBackgroundTask(
  deployment: boolean,
  org: OrgSettings["wakeOnBackgroundTask"],
): boolean {
  return org ?? deployment;
}

/**
 * The org's effective sandbox limits (C19 / Ruling M16): the super admin's override (deployment
 * setting `sandboxLimitOverrides[orgId]`) replaces the deployment's cpu / memoryMb; fields it does
 * not give, disk and the network, stay as in `deployment`. Read only when an instance is created.
 */
export function effectiveSandboxLimits<L extends SandboxLimits>(
  deployment: L,
  override: { cpu?: number | undefined; memoryMb?: number | undefined } | undefined,
): L {
  return {
    ...deployment,
    network: { ...deployment.network, hosts: [...deployment.network.hosts] },
    ...(override?.cpu !== undefined && { cpu: override.cpu }),
    ...(override?.memoryMb !== undefined && { memoryMb: override.memoryMb }),
  };
}

/** 组织设置 GET 带回的只读沙箱限额：实际生效值与来源（有超级管理员的覆盖为 `override`）。 */
export interface OrgSandboxLimits {
  cpu: number;
  memoryMb: number;
  source: "deployment" | "override";
}

/** The org's effective sandbox-mode network (`effectiveNetwork` of the settings responses). */
export interface OrgEffectiveNetwork {
  mode: "open" | "allowlist";
  hosts: string[];
}

/** The deployment defaults the settings page shows for "follow the platform" (`GET` returns them). */
export interface OrgSettingsDeployment {
  /** The platform's outside-sandbox ceiling and where it comes from. */
  outsideSandbox: DevicesOutsideSandboxView;
  /**
   * The platform's device network: its default and ceiling with their sources, its allowlist
   * (what an org's delta applies to), whether orgs may go beyond it (`sandbox.limits.orgHosts`)
   * and the kill switch (`off`: `sandbox.limits.egress` is `none`).
   */
  deviceNetwork: DevicesNetworkView & {
    allowHosts: string[];
    orgHosts: "extend" | "within";
    off: boolean;
  };
  /** The platform's effective attribution defaults for agent-created commits and pull requests. */
  attribution: PlatformAttribution;
  /**
   * Whether the deployment set `http.publicUrl`. Without it a requested conversation link cannot be
   * added to a pull request, so the agent page can say why the link setting has no effect.
   */
  publicUrl: boolean;
  /** The platform's conversation compaction settings (what "follow the platform" means). */
  compaction: CompactionSettings;
  /** The platform's external sharing switch and its source (deny: the org cannot turn it on). */
  externalSharing: ExternalSharingView;
  /** The longest expiry a share may take, in days. */
  shareMaxExpiryDays: number;
  /** The platform's prompt suggestions switch (off: the org's own switch has no effect). */
  promptSuggestions: "on" | "off";
}

/** Compare by value (`deviceNetwork` is an object); the schema fixes the key order. */
const sameSettings = (a: OrgSettings, b: OrgSettings): boolean =>
  JSON.stringify(OrgSettingsSchema.parse(a)) === JSON.stringify(OrgSettingsSchema.parse(b));

const asObject = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/**
 * Parses the stored jsonb into settings (leniently, see {@link OrgSettingsSchema}).
 * `outsideSandbox` and `deviceNetwork` are read over the new and the old keys the permission
 * configuration publication has not converted yet ({@link orgDeviceSandboxOf}; fail closed).
 */
export function parseOrgSettings(raw: unknown): OrgSettings {
  const stored = asObject(raw);
  const settings = OrgSettingsSchema.parse(stored);
  const { outsideSandbox, deviceNetwork } = orgDeviceSandboxOf(stored);
  if (outsideSandbox === undefined) delete settings.outsideSandbox;
  else settings.outsideSandbox = outsideSandbox;
  if (deviceNetwork === undefined) delete settings.deviceNetwork;
  else settings.deviceNetwork = deviceNetwork;
  return settings;
}

/** The org's stored settings jsonb, read live; undefined when the org is missing or deleted. */
export async function readStoredOrgSettings(db: KernelSchemaDb, orgId: string): Promise<unknown> {
  const row = await db
    .selectFrom("orgs")
    .select("settings")
    .where("id", "=", orgId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  return row?.settings;
}

/**
 * Reads the org settings (live from PG every time, so a change applies at once across replicas);
 * a missing or deleted org reads as the defaults. With `log`, an
 * unreadable security setting ({@link logUnreadableSecuritySettings}) is logged.
 */
export async function readOrgSettings(
  db: KernelSchemaDb,
  orgId: string,
  /** Per-call paths (the tool policy) log at debug; the settings reads and the fire warn. */
  log?: Pick<KernelLogger, "debug">,
): Promise<OrgSettings> {
  const raw = await readStoredOrgSettings(db, orgId);
  if (log !== undefined) {
    logUnreadableSecuritySettings((msg, f) => log.debug(msg, f), orgId, raw);
  }
  return parseOrgSettings(raw);
}

/** Whether a stored settings object holds a `sandboxToolPolicy` this version reads as `ask`. */
export function invalidStoredSandboxToolPolicy(raw: unknown): boolean {
  const v = asObject(raw).sandboxToolPolicy;
  return v !== undefined && !OrgSettingsPatchSchema.shape.sandboxToolPolicy.safeParse(v).success;
}

/**
 * Whether the stored scheduled-task `forbiddenTools` cannot be read: the group or the field is
 * present but not an object / a list. Unattended runs of such an org fail
 * ({@link FORBIDDEN_TOOLS_UNREADABLE_ERROR}) rather than run with nothing forbidden. Invalid
 * entries inside a list are dropped instead (the valid ones stay forbidden).
 */
export function invalidStoredForbiddenTools(raw: unknown): boolean {
  const group = asObject(raw).scheduledTasks;
  if (group === undefined) return false;
  if (group === null || typeof group !== "object" || Array.isArray(group)) return true;
  const v = (group as Record<string, unknown>).forbiddenTools;
  return v !== undefined && !Array.isArray(v);
}

/** The refusal of an unattended run of an org whose `forbiddenTools` cannot be read. */
export const FORBIDDEN_TOOLS_UNREADABLE_ERROR =
  "The organization's forbidden tool list for scheduled tasks is unreadable, so this scheduled run cannot continue; an org admin must save the list again in the organization's scheduled task settings.";

/** The refusal of a new task grant while the org's `forbiddenTools` cannot be read. */
export const FORBIDDEN_TOOLS_UNREADABLE_GRANT_ERROR =
  "The organization's forbidden tool list for scheduled tasks is unreadable, so no tool can be approved for a task now; an org admin must save the list again in the organization's scheduled task settings.";

/**
 * Logs (through `log`, at the caller's level) the security settings a stored value reads narrower
 * than written, with the org id.
 */
export function logUnreadableSecuritySettings(
  log: (msg: string, fields: Record<string, unknown>) => void,
  orgId: string,
  raw: unknown,
): void {
  if (invalidStoredSandboxToolPolicy(raw)) {
    log("org settings: stored sandboxToolPolicy is invalid; it reads as ask", { orgId });
  }
  if (invalidStoredForbiddenTools(raw)) {
    log(
      "org settings: stored scheduledTasks.forbiddenTools is unreadable; unattended runs fail until an org admin saves it again",
      { orgId },
    );
  }
}

const outsideSandboxNotAllowed = (message: string): ApiError =>
  new ApiError("org.outside_sandbox_not_allowed", message);

const networkNotAllowed = (message: string, field: "default" | "ceiling"): ApiError =>
  new ApiError("org.network_not_allowed", message, [{ path: `deviceNetwork.${field}` }]);

const externalSharingNotAllowed = (message: string): ApiError =>
  new ApiError("org.external_sharing_not_allowed", message);

/** Whether a stored settings object holds an `externalSharing` this version reads as `off`. */
export function invalidStoredExternalSharing(raw: unknown): boolean {
  const v = asObject(raw).externalSharing;
  return v !== undefined && !ExternalSharingSetting.safeParse(v).success;
}

/** Whether a stored settings object holds a `promptSuggestions` this version reads as `off`. */
export function invalidStoredPromptSuggestions(raw: unknown): boolean {
  const v = asObject(raw).promptSuggestions;
  return v !== undefined && !PromptSuggestionsSetting.safeParse(v).success;
}

/** Whether a stored settings object holds an `outsideSandbox` this version reads as `off`. */
export function invalidStoredOutsideSandbox(raw: unknown): boolean {
  const v = asObject(raw).outsideSandbox;
  return v !== undefined && !OutsideSandboxSetting.safeParse(v).success;
}

/** Whether a stored settings object holds a `deviceNetwork` this version reads as an empty allowlist. */
export function invalidStoredDeviceNetwork(raw: unknown): boolean {
  const v = asObject(raw).deviceNetwork;
  return v !== undefined && !DeviceNetworkSettingSchema.safeParse(v).success;
}

/**
 * Whether `next`'s default or ceiling (absent: follow the platform, read as open, the widest the
 * platform may relax to) opens where `prev`'s is the allowlist.
 */
export function deviceNetworkModeWidens(
  prev: DeviceNetworkSetting | undefined,
  next: DeviceNetworkSetting | undefined,
): "default" | "ceiling" | null {
  const mode = (v: DeviceNetworkMode | undefined) => v ?? "open";
  if (mode(next?.ceiling) === "open" && mode(prev?.ceiling) !== "open") return "ceiling";
  if (mode(next?.default) === "open" && mode(prev?.default) !== "open") return "default";
  return null;
}

/** The org's effective network default and ceiling: its own, within the platform's. */
export function effectiveOrgNetwork(
  platform: { default: DeviceNetworkMode; ceiling: DeviceNetworkMode },
  org: DeviceNetworkSetting | undefined,
): { default: DeviceNetworkMode; ceiling: DeviceNetworkMode } {
  const ceiling =
    platform.ceiling === "allowlist" || org?.ceiling === "allowlist" ? "allowlist" : "open";
  const def = ceiling === "allowlist" ? "allowlist" : (org?.default ?? platform.default);
  return { default: def, ceiling };
}

/** Which effective field opens from `a` to `b`, if any. */
export function effectiveNetworkWidens(
  a: { default: DeviceNetworkMode; ceiling: DeviceNetworkMode },
  b: { default: DeviceNetworkMode; ceiling: DeviceNetworkMode },
): "default" | "ceiling" | null {
  if (a.ceiling === "allowlist" && b.ceiling === "open") return "ceiling";
  if (a.default === "allowlist" && b.default === "open") return "default";
  return null;
}

/**
 * Whether `next`'s hosts (absent: follow the platform) widen `prev`'s (org egress ceiling spec
 * §D3), both normalized (base platform, empty lists): base none to platform; with base platform,
 * dropping one of the stored exclusions; an extra host no stored extra covers. Over-strict on
 * purpose: moving to base none with a platform entry as an extra is a narrowing these rules refuse
 * (a token cannot pin a platform host the platform may drop later).
 */
export function deviceNetworkHostsWiden(
  prev: DeviceNetworkSetting | undefined,
  next: DeviceNetworkSetting | undefined,
): boolean {
  const base = (v: DeviceNetworkSetting | undefined) => v?.base ?? "platform";
  if (base(next) === "platform" && base(prev) === "none") return true;
  if (base(next) === "platform") {
    const kept = new Set(next?.excludedHosts ?? []);
    if ((prev?.excludedHosts ?? []).some((h) => !kept.has(h))) return true;
  }
  const prevExtra = (prev?.extraHosts ?? []).map((h) => h.toLowerCase());
  return (next?.extraHosts ?? []).some(
    (h) => !prevExtra.some((p) => coversHost(p, h.toLowerCase())),
  );
}

/** Org settings: read and update (an update needs `org.update`, re-checks the role under the lock and is audited). */
@Injectable()
export class OrgSettingsService {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(OrgLock) private readonly orgLock: OrgLock,
    /**
     * The deployment config: `sandbox.limits` and the platform's device sandbox settings
     * (`devices.outsideSandbox`, `devices.network`; the org may follow them, never exceed them).
     */
    @Inject(KernelConfigService)
    private readonly config: Pick<KernelConfigService, "get" | "fieldSource">,
    @Inject(PermissionCeilingWrites) private readonly ceilings: PermissionCeilingWrites,
    @Optional() @Inject(KERNEL_LOGGER) private readonly log?: KernelLogger,
  ) {}

  /** Parses stored settings, warning when an invalid `outsideSandbox` narrows to `off`, an
   * invalid `deviceNetwork` to an empty allowlist, or a security setting reads narrower
   * ({@link logUnreadableSecuritySettings}, warn). */
  private parseStored(orgId: string, raw: unknown): OrgSettings {
    if (invalidStoredOutsideSandbox(raw)) {
      this.log?.warn("org settings: stored outsideSandbox is invalid; it reads as off", { orgId });
    }
    if (invalidStoredExternalSharing(raw)) {
      this.log?.warn("org settings: stored externalSharing is invalid; it reads as off", { orgId });
    }
    if (invalidStoredPromptSuggestions(raw)) {
      this.log?.warn("org settings: stored promptSuggestions is invalid; it reads as off", {
        orgId,
      });
    }
    if (invalidStoredDeviceNetwork(raw)) {
      this.log?.warn(
        "org settings: stored deviceNetwork is invalid; it reads as an empty allowlist",
        {
          orgId,
        },
      );
    }
    const log = this.log;
    if (log !== undefined) logUnreadableSecuritySettings((m, f) => log.warn(m, f), orgId, raw);
    return parseOrgSettings(raw);
  }

  /** The deployment defaults (what "follow the platform" means on the settings page). */
  async deployment(): Promise<OrgSettingsDeployment> {
    const lim = this.config.get().sandbox.limits;
    const [
      deviceSandbox,
      attribution,
      compaction,
      externalSharing,
      shareMaxExpiry,
      promptSuggestions,
    ] = await Promise.all([
      readDeviceSandboxSettingsView(this.db.db, this.config, this.log),
      readPlatformAttribution(this.db.db, this.config, this.log),
      readPlatformCompactionSettings(this.db.db),
      readExternalSharing(this.db.db, this.config, this.log),
      readShareMaxExpiry(this.db.db, this.config, this.log),
      readPromptSuggestions(this.db.db, this.log),
    ]);
    return {
      outsideSandbox: deviceSandbox.outsideSandbox,
      deviceNetwork: {
        ...deviceSandbox.network,
        allowHosts: [...lim.allowHosts],
        orgHosts: lim.orgHosts,
        off: lim.egress === "none",
      },
      attribution,
      publicUrl: this.config.get().http.publicUrl !== undefined,
      compaction,
      externalSharing,
      shareMaxExpiryDays: shareMaxExpiry.value,
      promptSuggestions,
    };
  }

  /** Whether prompt suggestions run for the org now: one read of the platform and of the org. */
  async promptSuggestionsEnabled(orgId: string): Promise<boolean> {
    const [platform, row] = await Promise.all([
      readPromptSuggestions(this.db.db, this.log),
      this.db
        .selectFrom("orgs")
        .select("settings")
        .where("id", "=", orgId)
        .where("deleted_at", "is", null)
        .executeTakeFirst(),
    ]);
    if (!row) return false;
    return effectivePromptSuggestions(platform, parseOrgSettings(row.settings).promptSuggestions);
  }

  /**
   * The org's effective sandbox network (spec §D3): its mode and the hosts, from the platform's
   * `sandbox.limits` and the org's stored delta.
   */
  effectiveNetwork(settings: Pick<OrgSettings, "deviceNetwork">): OrgEffectiveNetwork {
    const lim = this.config.get().sandbox.limits;
    return {
      mode: orgCloudMode(lim, settings.deviceNetwork),
      hosts: orgEffectiveHosts(lim, settings.deviceNetwork),
    };
  }

  /** 组织实际生效的沙箱 cpu / 内存（只读；由超级管理员在部署设置里覆盖）。 */
  async sandboxLimits(orgId: string): Promise<OrgSandboxLimits> {
    const lim = this.config.get().sandbox.limits;
    const override: SandboxLimitOverride | undefined = await readSandboxLimitOverride(
      this.db.db,
      orgId,
    );
    return {
      cpu: override?.cpu ?? lim.cpu,
      memoryMb: override?.memoryMb ?? lim.memoryMb,
      source: override === undefined ? "deployment" : "override",
    };
  }

  async get(orgId: string): Promise<OrgSettingsView> {
    const row = await this.db
      .selectFrom("orgs")
      .select("settings")
      .where("id", "=", orgId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!row) throw new ApiError("org.not_found", "Organization not found");
    return viewOf(this.parseStored(orgId, row.settings), row.settings);
  }

  /**
   * The refusals of {@link update} that need no read of the org (the Platform tool's precheck):
   * running outside the sandbox where the platform turned it off, a network default or ceiling
   * above the platform's ceiling, external sharing where the platform denies it.
   */
  async check(patch: OrgSettingsPatch): Promise<void> {
    if (patch.outsideSandbox === "allowed" || patch.deviceNetwork != null) {
      const platform = await readDeviceSandboxSettingsView(this.db.db, this.config, this.log);
      // allowing outside-sandbox runs where the platform turned them off is wider than it allows
      if (patch.outsideSandbox === "allowed" && platform.outsideSandbox.permission === "off") {
        throw outsideSandboxNotAllowed(
          "The platform does not allow running outside the sandbox; a super admin must allow it in the admin console settings first",
        );
      }
      const net = patch.deviceNetwork;
      if (net != null && platform.network.ceiling === "allowlist") {
        for (const field of ["ceiling", "default"] as const)
          if (net[field] === "open")
            throw networkNotAllowed(
              `The platform limits device networks to the allowlist, so the organization's network ${field} cannot be open; a super admin sets devices.network.ceiling`,
              field,
            );
      }
    }
    if (patch.externalSharing === "on") {
      const platform = await readExternalSharing(this.db.db, this.config, this.log);
      if (platform.value !== "allow") {
        throw externalSharingNotAllowed(
          "The platform does not allow external sharing; a super admin must allow it in the admin console settings first",
        );
      }
    }
  }

  /**
   * Under `sandbox.limits.orgHosts: within` (spec §D2), refuses an extra host outside the
   * platform's allowlist that the org did not store. Stored values are sent back as they are (the
   * PATCH replaces `deviceNetwork` whole) and have no effect under the ceiling (they are filtered on
   * read), so they never block a write. Whether the network may be open is the network ceiling's
   * (`devices.network.ceiling`, {@link check}), not `orgHosts`'.
   */
  assertWithinCeiling(before: OrgSettings, patch: OrgSettingsPatch): void {
    const cn = patch.deviceNetwork;
    if (cn == null) return;
    const lim = this.config.get().sandbox.limits;
    if (lim.orgHosts !== "within") return;
    const stored = new Set(before.deviceNetwork?.extraHosts ?? []);
    const outside = (cn.extraHosts ?? []).filter(
      (h) => !stored.has(h) && orgHostOutsideCeiling(lim, h),
    );
    if (outside.length > 0) {
      throw new ApiError(
        "org.sandbox_egress_not_allowed",
        `The platform limits sandbox hosts to its allowlist; ask a super admin to add ${outside.join(", ")} to sandbox.limits.allowHosts`,
        [{ reason: "outside_ceiling", hosts: outside }],
      );
    }
  }

  async update(
    orgId: string,
    patch: OrgSettingsPatch,
    actorAccountId: string,
    actorTokenId?: string,
    /** Merged into the audit detail (the Platform tool's `via: "agent"`). */
    auditDetail?: Record<string, unknown>,
    /**
     * `onlyNarrows` (the Platform tool, API tokens): refuse an `outsideSandbox`, `deviceNetwork` or
     * `externalSharing` change that widens (see {@link assertOnlyNarrows}); only a person in a
     * session widens.
     */
    opts?: { onlyNarrows?: boolean },
  ): Promise<OrgSettingsView> {
    await this.check(patch);
    // the org row, then (for a device sandbox change) the org's permission authority lock:
    // the ordered prelude, so inside a run's fence (the Platform tool's `org-settings.update`) they
    // precede the conversation rows; the patch decides the lock, so nothing can change it
    return withOrderedLocks(
      () => this.lockFor(orgId, patch, actorAccountId),
      () => this.updateIn(orgId, patch, actorAccountId, actorTokenId, auditDetail, opts),
    );
  }

  @Transactional({ propagation: "mandatory" })
  private async lockFor(
    orgId: string,
    patch: OrgSettingsPatch,
    actorAccountId: string,
  ): Promise<void> {
    await this.orgLock.lockAndAuthorize(orgId, actorAccountId, "org.update");
    if (patch.outsideSandbox !== undefined || patch.deviceNetwork !== undefined)
      await this.ceilings.lock({ orgId }, "org");
  }

  /**
   * Refuses a patch that widens the org's sandbox (only a person widens it, never the Platform tool
   * or an API token):
   * - `outsideSandbox`: `allowed` where the organization runs `off` (an absent value follows the
   *   platform); clearing it follows the platform too, never wider than the platform allows
   *   (`org.outside_sandbox_not_allowed`);
   * - `deviceNetwork`: compared as stored deltas, never as effective values (under the kill switch
   *   or a platform ceiling the effective values hide a widening that takes effect when the
   *   platform relaxes, org egress ceiling spec §D3): a default or ceiling opened
   *   ({@link deviceNetworkModeWidens}, `org.network_not_allowed`) or wider hosts
   *   ({@link deviceNetworkHostsWiden}, `org.sandbox_egress_not_allowed`);
   * - `externalSharing`: `on` where the org is off (absent = off).
   */
  async assertOnlyNarrows(before: OrgSettings, patch: OrgSettingsPatch): Promise<void> {
    if (patch.outsideSandbox !== undefined) {
      const platform = await readDeviceSandboxSettingsView(this.db.db, this.config, this.log);
      const was = before.outsideSandbox ?? platform.outsideSandbox.permission;
      const next =
        patch.outsideSandbox === null ? platform.outsideSandbox.permission : patch.outsideSandbox;
      if (was !== "allowed" && next === "allowed") {
        throw outsideSandboxNotAllowed(
          "Allowing devices to run outside the sandbox needs a person in the organization settings.",
        );
      }
    }
    if (patch.deviceNetwork !== undefined) {
      const next = patch.deviceNetwork ?? undefined;
      // the stored delta (a widening that takes effect when the platform relaxes) and the
      // effective value (an absent field follows the platform's) must both not open
      const platform = await readDeviceSandboxSettingsView(this.db.db, this.config, this.log);
      const field =
        deviceNetworkModeWidens(before.deviceNetwork, next) ??
        effectiveNetworkWidens(
          effectiveOrgNetwork(platform.network, before.deviceNetwork),
          effectiveOrgNetwork(platform.network, next),
        );
      if (field !== null)
        throw networkNotAllowed(
          `Opening the organization's network ${field} needs a person in the organization settings.`,
          field,
        );
      if (deviceNetworkHostsWiden(before.deviceNetwork, next))
        throw new ApiError(
          "org.sandbox_egress_not_allowed",
          "Widening the organization's device network hosts needs a person in the organization settings.",
        );
    }
    if (patch.externalSharing === "on" && before.externalSharing !== "on") {
      throw externalSharingNotAllowed(
        "Turning external sharing on needs a person in the organization settings on the web; an API token or the Platform tool may only turn it off.",
      );
    }
  }

  @Transactional()
  private async updateIn(
    orgId: string,
    patch: OrgSettingsPatch,
    actorAccountId: string,
    actorTokenId: string | undefined,
    auditDetail: Record<string, unknown> | undefined,
    opts: { onlyNarrows?: boolean } | undefined,
  ): Promise<OrgSettingsView> {
    // held since the prelude (`lockFor`); naming them again re-checks the actor's role
    await this.lockFor(orgId, patch, actorAccountId);
    const row = await this.db
      .selectFrom("orgs")
      .select("settings")
      .where("id", "=", orgId)
      .executeTakeFirstOrThrow();
    const stored = asObject(row.settings);
    const before = this.parseStored(orgId, stored);
    // again under the org lock: a hot config reload may have lowered the platform since
    await this.check(patch);
    // under the org lock, so the comparison is with the value the write replaces
    this.assertWithinCeiling(before, patch);
    if (opts?.onlyNarrows) await this.assertOnlyNarrows(before, patch);
    const changes = Object.fromEntries(
      Object.entries(patch)
        .filter(([, v]) => v !== undefined)
        // null clears outsideSandbox / deviceNetwork / wakeOnBackgroundTask (follow the deployment
        // again), externalSharing (off) and promptSuggestions (follow the platform)
        .map(([k, v]) => [k, v === null ? undefined : v]),
    ) as Partial<OrgSettings>;
    const arrangementPatch = patch.uiArrangement;
    const compactionPatch = patch.compaction;
    delete changes.uiArrangement;
    delete changes.scheduledTasks;
    delete changes.compaction;
    const after: OrgSettings = { ...before, ...changes };
    if (patch.scheduledTasks !== undefined) {
      after.scheduledTasks = ScheduledTasksSettingsSchema.parse({
        ...before.scheduledTasks,
        ...Object.fromEntries(
          Object.entries(patch.scheduledTasks).filter(([, v]) => v !== undefined),
        ),
      });
    }
    if (compactionPatch !== undefined) {
      // a partial object merges into the stored fields; null clears the whole override
      if (compactionPatch === null) delete after.compaction;
      else after.compaction = { ...before.compaction, ...compactionPatch };
    }
    if (arrangementPatch !== undefined) {
      after.uiArrangement = mergeArrangement(before.uiArrangement, arrangementPatch);
      if (Object.keys(after.uiArrangement).length === 0) delete after.uiArrangement;
    }
    // Stored old keys (`autoMode`, `fullAccess`, `cloudNetwork`) are never dropped here: only the
    // permission configuration publication converts them (a mismatch window before activation
    // keeps them). `before` already reads them narrowed (orgDeviceSandboxOf), so a write that does
    // not choose a value stores what every reader already sees (never refused, never wider), and
    // the old keys are carried in step below.
    if (after.outsideSandbox === undefined) delete after.outsideSandbox;
    if (after.deviceNetwork === undefined) delete after.deviceNetwork;
    if (after.wakeOnBackgroundTask === undefined) delete after.wakeOnBackgroundTask;
    if (after.timeZone === undefined) delete after.timeZone;
    if (after.theme === undefined) delete after.theme;
    if (after.uiArrangement === undefined) delete after.uiArrangement;
    if (after.gitGateway === undefined) delete after.gitGateway;
    // an empty compaction override is the same as none: follow the platform
    if (after.compaction !== undefined && Object.keys(after.compaction).length === 0) {
      delete after.compaction;
    }
    if (after.compaction === undefined) delete after.compaction;
    if (after.externalSharing === undefined) delete after.externalSharing;
    if (after.promptSuggestions === undefined) delete after.promptSuggestions;
    // saving an unreadable security setting writes it even when it equals what it read as
    const repairs =
      (invalidStoredForbiddenTools(stored) && patch.scheduledTasks?.forbiddenTools !== undefined) ||
      (invalidStoredSandboxToolPolicy(stored) && patch.sandboxToolPolicy !== undefined);
    if (!repairs && sameSettings(before, after)) return viewOf(before, stored);
    // Lock order: the org row (orgLock above), then the theme's catalog item and its row FOR
    // SHARE (assertThemeOnIn), then the check, so no scope writer changes what it read first
    if (patch.theme?.id != null && patch.theme.id !== before.theme?.id) {
      await assertThemeOnIn(this.db.db, orgId, patch.theme.id);
    }
    // Merge with the stored value: keep the keys this version does not know (a cleared
    // outsideSandbox / deviceNetwork is not kept; the old keys are rewritten in step)
    const {
      autoMode: _legacyAutoMode,
      fullAccess: _legacyFullAccess,
      cloudNetwork: _legacyNetwork,
      outsideSandbox: _oldOutside,
      deviceNetwork: _oldNetwork,
      wakeOnBackgroundTask: _oldWake,
      timeZone: _oldZone,
      theme: _oldTheme,
      uiArrangement: _oldArrangement,
      scheduledTasks: _oldScheduled,
      compaction: _oldCompaction,
      externalSharing: _oldExternalSharing,
      promptSuggestions: _oldPromptSuggestions,
      ...rest
    } = stored;
    const written: Record<string, unknown> = { ...rest, ...after };
    keepOrgLegacyKeysInStep(written, stored);
    // An unreadable forbiddenTools reads as [] for display only: a write that does not replace the
    // list keeps it unreadable (never healed to "nothing forbidden"); saving the list fixes it
    if (invalidStoredForbiddenTools(stored) && patch.scheduledTasks?.forbiddenTools === undefined) {
      const group = asObject(stored.scheduledTasks);
      written.scheduledTasks = {
        ...after.scheduledTasks,
        forbiddenTools: group.forbiddenTools ?? null,
      };
    }
    await this.db
      .updateTable("orgs")
      .set({ settings: JSON.stringify(written) })
      .where("id", "=", orgId)
      .execute();
    await audit(this.db.db, {
      actorAccountId,
      ...(actorTokenId !== undefined && { actorTokenId }),
      orgId,
      action: "org.settings_updated",
      target: orgId,
      detail: { before, after, ...(repairs && { repaired: true }), ...auditDetail },
    });
    if (patch.outsideSandbox !== undefined || patch.deviceNetwork !== undefined) {
      // the consent reset follows the effective values as every reader sees them (re-read from
      // what was written, within the platform), so a widening the platform hides resets nothing
      const platform = await readDeviceSandboxSettingsView(this.db.db, this.config, this.log);
      const effOutside = (o: OrgSettings) =>
        platform.outsideSandbox.permission === "off" ? "off" : (o.outsideSandbox ?? "allowed");
      const reread = parseOrgSettings(written);
      const resetConsent =
        effOutside(before) !== effOutside(reread) ||
        effectiveNetworkWidens(
          effectiveOrgNetwork(platform.network, before.deviceNetwork),
          effectiveOrgNetwork(platform.network, reread.deviceNetwork),
        ) !== null;
      const machineRoots = await localMachineRoots(this.db.db, orgId);
      // a network ceiling narrowed to the allowlist takes running open-network work
      const networkNarrowed =
        effectiveOrgNetwork(platform.network, before.deviceNetwork).ceiling === "open" &&
        effectiveOrgNetwork(platform.network, reread.deviceNetwork).ceiling === "allowlist";
      await this.ceilings.publishLocked(
        { orgId },
        "org",
        (scope, row) => {
          if (networkNarrowed && needsOpenNetwork(scope)) return true;
          // outside off takes escalated work and restricted work outside the machine's roots;
          // anything else still goes through the host check below
          if (
            after.outsideSandbox === "off" &&
            needsWiderDeviceCeiling(scope, machineRoots.get(row.device_id))
          )
            return true;
          if (needsFullCeiling(scope)) return after.outsideSandbox === "off";
          if (
            !("network" in scope) ||
            !isExecutionMethod(row.method) ||
            scope.network.kind !== "allowlist"
          )
            return false;
          const hosts = this.effectiveNetwork(after).hosts;
          return scope.network.hosts.some(
            (host) =>
              !hosts.some((pattern) => coversHost(pattern, host)) &&
              !(this.effectiveNetwork(after).mode === "open" && row.granted_hosts.includes(host)),
          );
        },
        resetConsent,
      );
    }
    return viewOf(after, written);
  }
}

/**
 * The one {@link OrgSettingsService}: the orgs module re-exports it, and the catalog imports it
 * directly (approving a network request writes the org's device network) without a cycle through
 * OrgsModule.
 */
@Module({
  imports: [OrgLockModule, PermissionAuthorityModule],
  providers: [OrgSettingsService],
  exports: [OrgSettingsService],
})
export class OrgSettingsModule {}
