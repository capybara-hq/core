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
  readSandboxLimitOverride,
  type SandboxLimitOverride,
} from "../identity/settings.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
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
  needsWiderDeviceCeiling,
  PermissionCeilingWrites,
} from "../sandbox/permission-ceiling-writes.js";
import {
  type DevicesAutoModeView,
  type DevicesFullAccessView,
  type FullAccessPermission,
  legacyAutoModeView,
  narrowedOrgFullAccess,
  readDevicesFullAccess,
} from "../sandbox/platform-full-access.js";
import { assertThemeOnIn } from "../themes/theme-state.js";
import { IanaTimeZone } from "../time-zone.js";
import {
  mergeArrangement,
  OrgUiArrangementPatchSchema,
  UiArrangementSchema,
} from "../ui/arrangement.js";
import {
  type CloudNetworkSetting,
  CloudNetworkSettingSchema,
  invalidCloudNetwork,
} from "./cloud-network-setting.js";
import { OrgLock, OrgLockModule } from "./org-lock.js";

/**
 * 组织设置（`capybara.orgs.settings` jsonb）。读取宽松：缺失或非法的字段按默认值，未知键保留不动
 * （更新时与存量合并），新版本加字段不需要迁移。
 * - `toolSearch`：工具超过阈值时是否改用目录 + `ToolSearch`（D11，默认 on）。
 * - `locale`：组织默认语言（`zh` / `en`，默认 en），机器人在 IM 里说的固定话术按它选择。
 * - `sandboxToolPolicy`：沙箱工具的默认策略（M5 T8，默认 allow）。为 `ask` 时除只读的
 *   `Read` / `Glob` / `Grep` 外都需要审批（执行时实时读取）。
 * - `wakeOnBackgroundTask`：组织对 `runtime.wakeOnBackgroundTask` 的覆盖（缺省跟随部署），见 {@link effectiveWakeOnBackgroundTask}。
 * - `fullAccess`: whether devices of the org may run with Full permission (permission runtime
 *   cutover B1, replacing `autoMode`); absent follows the platform's `devices.fullAccess`, and an
 *   invalid stored value reads as `off` (narrower, never wider). Setting `allowed` while the
 *   platform is `off` is refused.
 * - `cloudNetwork`: the org's sandbox-mode network as a delta over the platform's allowlist (org
 *   egress ceiling spec §D1, {@link CloudNetworkSettingSchema}). An invalid stored value reads as
 *   `{ mode: "allowlist", base: "none" }`, the empty allowlist (narrower, never wider).
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
  type CloudNetworkSetting,
  CloudNetworkSettingSchema,
  invalidCloudNetwork,
  ORG_SANDBOX_ALLOW_HOSTS_MAX,
} from "./cloud-network-setting.js";
/**
 * The org's Full permission switch (B1): `allowed` or `off`; absent follows the platform's
 * `devices.fullAccess`. An invalid stored value reads as `off` (narrower, never wider).
 */
export const FullAccessSetting = z.enum([
  "allowed",
  "off",
]) satisfies z.ZodType<FullAccessPermission>;

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
 * except `forbiddenTools`, which keeps its valid entries).
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

export const OrgSettingsSchema = z.object({
  toolSearch: z.enum(["on", "off"]).default("on").catch("on"),
  locale: z.enum(["zh", "en"]).default("en").catch("en"),
  sandboxToolPolicy: z.enum(["allow", "ask"]).default("allow").catch("allow"),
  platformTool: z.enum(["on", "read-only", "off"]).default("on").catch("on"),
  /** The org's Full permission switch (B1); absent follows the platform. */
  fullAccess: FullAccessSetting.optional().catch("off"),
  /** The org's network for cloud devices (auto mode spec §4.3); absent = open (the default). */
  cloudNetwork: CloudNetworkSettingSchema.optional().catch(invalidCloudNetwork),
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
});

export type OrgSettings = z.infer<typeof OrgSettingsSchema>;

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
     * The org's Full permission switch; null clears it (follow the platform). `allowed` while the
     * platform is `off` -> 400 `org.auto_mode_not_allowed`.
     */
    fullAccess: FullAccessSetting.nullable().optional(),
    /** The old name of `fullAccess`, still accepted (never together with it). */
    autoMode: FullAccessSetting.nullable().optional(),
    /**
     * The org's network for cloud devices, replaced whole (hosts left out follow the deployment);
     * null clears it (open). Through the Platform tool or an API token it may only narrow.
     */
    cloudNetwork: CloudNetworkSettingSchema.nullable().optional(),
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
  })
  .strict()
  .refine((p) => p.autoMode === undefined || p.fullAccess === undefined, {
    message: "give fullAccess only: autoMode is its old name",
    path: ["autoMode"],
  });

export type OrgSettingsPatch = z.infer<typeof OrgSettingsPatchSchema>;

/** A patch with the old `autoMode` moved to `fullAccess` (the schema refuses both together). */
export function normalizeOrgSettingsPatch(patch: OrgSettingsPatch): OrgSettingsPatch {
  if (patch.autoMode === undefined) return patch;
  const { autoMode, ...rest } = patch;
  return { ...rest, fullAccess: autoMode };
}

/**
 * The settings as the API answers them: the stored settings, plus the old public name `autoMode`
 * mirroring `fullAccess` until the old public readers are removed.
 */
export type OrgSettingsView = OrgSettings & { autoMode?: FullAccessPermission };
export const orgSettingsView = (settings: OrgSettings): OrgSettingsView => ({
  ...settings,
  ...(settings.fullAccess !== undefined && { autoMode: settings.fullAccess }),
});

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
export function effectiveSandboxLimits(
  deployment: SandboxLimits,
  override: { cpu?: number | undefined; memoryMb?: number | undefined } | undefined,
): SandboxLimits {
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
  /** The platform's Full permission switch and where it comes from. */
  fullAccess: DevicesFullAccessView;
  /** The same switch under its old public name (`{ mode, source }`). */
  autoMode: DevicesAutoModeView;
  /**
   * The platform's network: its allowlist (what an org's delta applies to), whether orgs may go
   * beyond it (`sandbox.limits.orgHosts`) and the kill switch (`off`: `sandbox.limits.egress` is
   * `none`).
   */
  cloudNetwork: { allowHosts: string[]; orgHosts: "extend" | "within"; off: boolean };
  /** The platform's effective attribution defaults for agent-created commits and pull requests. */
  attribution: PlatformAttribution;
  /**
   * Whether the deployment set `http.publicUrl`. Without it a requested conversation link cannot be
   * added to a pull request, so the agent page can say why the link setting has no effect.
   */
  publicUrl: boolean;
  /** The platform's conversation compaction settings (what "follow the platform" means). */
  compaction: CompactionSettings;
}

/** Compare by value (`cloudNetwork` is an object); the schema fixes the key order. */
const sameSettings = (a: OrgSettings, b: OrgSettings): boolean =>
  JSON.stringify(OrgSettingsSchema.parse(a)) === JSON.stringify(OrgSettingsSchema.parse(b));

const asObject = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/**
 * 把存储的 jsonb 解析为设置（宽松，见 {@link OrgSettingsSchema}）。Until 8.6 `fullAccess` is read
 * over both keys, the narrower of it and the old `autoMode` ({@link narrowedOrgFullAccess}).
 */
export function parseOrgSettings(raw: unknown): OrgSettings {
  const stored = asObject(raw);
  const settings = OrgSettingsSchema.parse(stored);
  const fullAccess = narrowedOrgFullAccess(settings.fullAccess, stored.autoMode);
  if (fullAccess === undefined) delete settings.fullAccess;
  else settings.fullAccess = fullAccess;
  return settings;
}

/** 读组织设置（每次实时读 PG，多副本下改动立即生效）；组织不存在或已删除按默认值。 */
export async function readOrgSettings(db: KernelSchemaDb, orgId: string): Promise<OrgSettings> {
  const row = await db
    .selectFrom("orgs")
    .select("settings")
    .where("id", "=", orgId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  return parseOrgSettings(row?.settings);
}

const autoModeNotAllowed = (message: string): ApiError =>
  new ApiError("org.auto_mode_not_allowed", message);

/** Whether a stored settings object holds a `fullAccess` this version reads as `off`. */
export function invalidStoredFullAccess(raw: unknown): boolean {
  const v = asObject(raw).fullAccess;
  return v !== undefined && !FullAccessSetting.safeParse(v).success;
}

/** Whether a stored settings object holds a `cloudNetwork` this version reads as an empty allowlist. */
export function invalidStoredCloudNetwork(raw: unknown): boolean {
  const v = asObject(raw).cloudNetwork;
  return v !== undefined && !CloudNetworkSettingSchema.safeParse(v).success;
}

/**
 * Whether `next` (absent: follow the platform) widens `prev` (spec §D3), both normalized (mode
 * open, base platform, empty lists): the open mode where it was the allowlist; base none to
 * platform; with base platform, dropping one of the stored exclusions; an extra host no stored
 * extra covers. Over-strict on purpose: moving to base none with a platform entry as an extra is a
 * narrowing these rules refuse (a token cannot pin a platform host the platform may drop later).
 */
export function cloudNetworkWidens(
  prev: CloudNetworkSetting | undefined,
  next: CloudNetworkSetting | undefined,
): boolean {
  const mode = (v: CloudNetworkSetting | undefined) => v?.mode ?? "open";
  const base = (v: CloudNetworkSetting | undefined) => v?.base ?? "platform";
  if (mode(next) === "open" && mode(prev) !== "open") return true;
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

/** 组织设置服务：读取与修改（修改需 `org.update`，锁内实时复核角色，写审计）。 */
@Injectable()
export class OrgSettingsService {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(OrgLock) private readonly orgLock: OrgLock,
    /**
     * The deployment config: `sandbox.limits` and the platform's Full switch
     * (`devices.fullAccess`; the org may follow it, never exceed it).
     */
    @Inject(KernelConfigService)
    private readonly config: Pick<KernelConfigService, "get" | "fieldSource">,
    @Inject(PermissionCeilingWrites) private readonly ceilings: PermissionCeilingWrites,
    @Optional() @Inject(KERNEL_LOGGER) private readonly log?: KernelLogger,
  ) {}

  /** Parses stored settings, warning when an invalid `fullAccess` narrows to `off` or an invalid
   * `cloudNetwork` to an empty allowlist. */
  private parseStored(orgId: string, raw: unknown): OrgSettings {
    if (invalidStoredFullAccess(raw)) {
      this.log?.warn("org settings: stored fullAccess is invalid; it reads as off", { orgId });
    }
    if (invalidStoredCloudNetwork(raw)) {
      this.log?.warn(
        "org settings: stored cloudNetwork is invalid; it reads as an empty allowlist",
        {
          orgId,
        },
      );
    }
    return parseOrgSettings(raw);
  }

  /** 部署默认值（设置页展示「跟随部署」时的实际取值）。 */
  async deployment(): Promise<OrgSettingsDeployment> {
    const lim = this.config.get().sandbox.limits;
    const [fullAccess, attribution, compaction] = await Promise.all([
      readDevicesFullAccess(this.db.db, this.config, this.log),
      readPlatformAttribution(this.db.db, this.config, this.log),
      readPlatformCompactionSettings(this.db.db),
    ]);
    return {
      fullAccess,
      autoMode: legacyAutoModeView(fullAccess),
      cloudNetwork: {
        allowHosts: [...lim.allowHosts],
        orgHosts: lim.orgHosts,
        off: lim.egress === "none",
      },
      attribution,
      publicUrl: this.config.get().http.publicUrl !== undefined,
      compaction,
    };
  }

  /**
   * The org's effective sandbox-mode network (spec §D3): the cloud network's mode and the hosts,
   * from the platform's `sandbox.limits` and the org's stored delta.
   */
  effectiveNetwork(settings: Pick<OrgSettings, "cloudNetwork">): OrgEffectiveNetwork {
    const lim = this.config.get().sandbox.limits;
    return {
      mode: orgCloudMode(lim, settings.cloudNetwork),
      hosts: orgEffectiveHosts(lim, settings.cloudNetwork),
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

  async get(orgId: string): Promise<OrgSettings> {
    const row = await this.db
      .selectFrom("orgs")
      .select("settings")
      .where("id", "=", orgId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!row) throw new ApiError("org.not_found", "Organization not found");
    return this.parseStored(orgId, row.settings);
  }

  /**
   * The refusals of {@link update} that need no read of the org (the Platform tool's precheck):
   * auto mode where the platform turned it off.
   */
  async check(input: OrgSettingsPatch): Promise<void> {
    const patch = normalizeOrgSettingsPatch(input);
    // allowing Full where the platform turned it off is wider than the platform allows
    if (patch.fullAccess === "allowed") {
      const platform = await readDevicesFullAccess(this.db.db, this.config, this.log);
      if (platform.permission === "off") {
        throw autoModeNotAllowed("The platform does not allow Full permission");
      }
    }
  }

  /**
   * Under `sandbox.limits.orgHosts: within` (spec §D2), refuses what would widen past the platform
   * ceiling compared with the stored value `before`: the open cloud network where the org did not
   * store it, or an extra host outside the platform's allowlist that the org did not store. Stored
   * values are sent back as they are (the PATCH replaces `cloudNetwork` whole) and have no effect
   * under the ceiling (they are filtered on read), so they never block a write.
   */
  assertWithinCeiling(before: OrgSettings, patch: OrgSettingsPatch): void {
    const cn = patch.cloudNetwork;
    if (cn == null) return;
    const lim = this.config.get().sandbox.limits;
    if (lim.orgHosts !== "within") return;
    if (cn.mode === "open" && before.cloudNetwork?.mode !== "open") {
      throw new ApiError(
        "org.sandbox_egress_not_allowed",
        "The platform limits sandbox networks to its allowlist; the open cloud network is not available",
        [{ reason: "open_not_allowed" }],
      );
    }
    const stored = new Set(before.cloudNetwork?.extraHosts ?? []);
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
    input: OrgSettingsPatch,
    actorAccountId: string,
    actorTokenId?: string,
    /** Merged into the audit detail (the Platform tool's `via: "agent"`). */
    auditDetail?: Record<string, unknown>,
    /**
     * `onlyNarrows` (the Platform tool, API tokens): refuse a `fullAccess` or `cloudNetwork`
     * change that widens (see {@link assertOnlyNarrows}); only a person in a session widens.
     */
    opts?: { onlyNarrows?: boolean },
  ): Promise<OrgSettings> {
    const patch = normalizeOrgSettingsPatch(input);
    await this.check(patch);
    return this.updateIn(orgId, patch, actorAccountId, actorTokenId, auditDetail, opts);
  }

  /**
   * Refuses a patch that widens the org's sandbox (auto mode spec §4.3: only a person widens it,
   * never the Platform tool or an API token):
   * - `fullAccess`: `allowed` where the organization runs `off` (an absent value follows the
   *   platform); clearing it follows the platform too, never wider than the platform allows;
   * - `cloudNetwork`: compared as stored deltas ({@link cloudNetworkWidens}), never as effective
   *   values: under the kill switch or the platform ceiling the effective values hide a widening
   *   that takes effect when the platform relaxes (org egress ceiling spec §D3).
   */
  async assertOnlyNarrows(before: OrgSettings, input: OrgSettingsPatch): Promise<void> {
    const patch = normalizeOrgSettingsPatch(input);
    if (patch.fullAccess !== undefined) {
      const platform = await readDevicesFullAccess(this.db.db, this.config, this.log);
      const next = patch.fullAccess === null ? platform.permission : patch.fullAccess;
      if ((before.fullAccess ?? platform.permission) !== "allowed" && next === "allowed") {
        throw autoModeNotAllowed(
          "Allowing Full permission needs a person in the organization settings.",
        );
      }
    }
    if (
      patch.cloudNetwork !== undefined &&
      cloudNetworkWidens(before.cloudNetwork, patch.cloudNetwork ?? undefined)
    ) {
      throw new ApiError(
        "org.sandbox_egress_not_allowed",
        "Widening the cloud network needs a person in the organization settings.",
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
  ): Promise<OrgSettings> {
    await this.orgLock.lockAndAuthorize(orgId, actorAccountId, "org.update");
    if (patch.fullAccess !== undefined || patch.cloudNetwork !== undefined)
      await this.ceilings.lock({ orgId }, "org");
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
        // null clears fullAccess / cloudNetwork / wakeOnBackgroundTask: follow the deployment again
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
    // Until 8.6 a stored old `autoMode` is never dropped: an unconverted key (or one an old
    // replica wrote again) is carried in step with `fullAccess`, since old replicas still read it.
    // A write that does not choose the value stores what every reader already sees: the narrower
    // of the two (never refused, never wider).
    const legacy = "autoMode" in stored;
    if (legacy && patch.fullAccess === undefined)
      after.fullAccess = narrowedOrgFullAccess(before.fullAccess, stored.autoMode);
    if (after.fullAccess === undefined) delete after.fullAccess;
    if (after.cloudNetwork === undefined) delete after.cloudNetwork;
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
    if (sameSettings(before, after)) return before;
    // Lock order: the org row (orgLock above), then the theme's catalog item and its row FOR
    // SHARE (assertThemeOnIn), then the check, so no scope writer changes what it read first
    if (patch.theme?.id != null && patch.theme.id !== before.theme?.id) {
      await assertThemeOnIn(this.db.db, orgId, patch.theme.id);
    }
    // Merge with the stored value: keep the keys this version does not know (a cleared fullAccess /
    // cloudNetwork is not kept, nor the old name autoMode)
    const {
      autoMode: _legacyAutoMode,
      fullAccess: _oldFullAccess,
      cloudNetwork: _oldNetwork,
      wakeOnBackgroundTask: _oldWake,
      timeZone: _oldZone,
      theme: _oldTheme,
      uiArrangement: _oldArrangement,
      scheduledTasks: _oldScheduled,
      compaction: _oldCompaction,
      ...rest
    } = stored;
    await this.db
      .updateTable("orgs")
      .set({
        settings: JSON.stringify({
          ...rest,
          ...after,
          ...(legacy && after.fullAccess !== undefined && { autoMode: after.fullAccess }),
        }),
      })
      .where("id", "=", orgId)
      .execute();
    await audit(this.db.db, {
      actorAccountId,
      ...(actorTokenId !== undefined && { actorTokenId }),
      orgId,
      action: "org.settings_updated",
      target: orgId,
      detail: { before, after, ...auditDetail },
    });
    if (patch.fullAccess !== undefined || patch.cloudNetwork !== undefined) {
      const machineRoots = await localMachineRoots(this.db.db, orgId);
      await this.ceilings.publishLocked(
        { orgId },
        "org",
        (scope, row) => {
          if (needsWiderDeviceCeiling(scope, machineRoots.get(row.device_id)))
            return after.fullAccess === "off";
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
        before.fullAccess !== after.fullAccess,
      );
    }
    return after;
  }
}

/**
 * The one {@link OrgSettingsService}: the orgs module re-exports it, and the catalog imports it
 * directly (approving a network request writes the org's cloud network) without a cycle through
 * OrgsModule.
 */
@Module({
  imports: [OrgLockModule, PermissionAuthorityModule],
  providers: [OrgSettingsService],
  exports: [OrgSettingsService],
})
export class OrgSettingsModule {}
