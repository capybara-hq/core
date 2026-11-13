import { type SandboxLimits, validateAllowHost } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable, Module, Optional } from "@nestjs/common";
import { z } from "zod";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { audit } from "../identity/audit.js";
import { readSandboxLimitOverride, type SandboxLimitOverride } from "../identity/settings.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import {
  type DevicesAutoMode,
  type DevicesAutoModeView,
  readDevicesAutoMode,
} from "../sandbox/platform-auto-mode.js";
import { assertThemeOnIn } from "../themes/theme-state.js";
import { IanaTimeZone } from "../time-zone.js";
import {
  mergeArrangement,
  OrgUiArrangementPatchSchema,
  UiArrangementSchema,
} from "../ui/arrangement.js";
import { OrgLock, OrgLockModule } from "./org-lock.js";

/**
 * 组织设置（`capybara.orgs.settings` jsonb）。读取宽松：缺失或非法的字段按默认值，未知键保留不动
 * （更新时与存量合并），新版本加字段不需要迁移。
 * - `toolSearch`：工具超过阈值时是否改用目录 + `ToolSearch`（D11，默认 on）。
 * - `locale`：组织默认语言（`zh` / `en`，默认 en），机器人在 IM 里说的固定话术按它选择。
 * - `sandboxToolPolicy`：沙箱工具的默认策略（M5 T8，默认 allow）。为 `ask` 时除只读的
 *   `Read` / `Glob` / `Grep` 外都需要审批（执行时实时读取）。
 * - `wakeOnBackgroundTask`：组织对 `runtime.wakeOnBackgroundTask` 的覆盖（缺省跟随部署），见 {@link effectiveWakeOnBackgroundTask}。
 * - `autoMode`: whether devices of the org may run in auto mode (auto mode spec §4.3); absent
 *   follows the platform's `devices.autoMode`, and an invalid stored value reads as `off`
 *   (narrower, never wider). Setting `allowed` while the platform is `off` is refused.
 * - `cloudNetwork`: the org's network for cloud devices (auto mode spec §4.3): `open` (any public
 *   host; the default) or `allowlist` with `allowHosts` (the deployment's list when omitted). An
 *   invalid stored value reads as `{ mode: "allowlist", allowHosts: [] }` (narrower, never wider).
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

/** The org cloud-network allowlist's host limit. */
export const ORG_SANDBOX_ALLOW_HOSTS_MAX = 200;

/**
 * The org's network for cloud devices (auto mode spec §4.3): `open` (any public host; loopback,
 * private and cloud metadata addresses are blocked outside the container) or `allowlist` with
 * `allowHosts`. `allowHosts` given **replaces** the deployment's list (the org may drop the presets
 * and add its own hosts); omitted, the deployment's `sandbox.limits.allowHosts` applies.
 */
export const CloudNetworkSettingSchema = z
  .object({
    mode: z.enum(["open", "allowlist"]),
    allowHosts: z
      .array(z.string())
      .max(ORG_SANDBOX_ALLOW_HOSTS_MAX)
      .superRefine((hosts, ctx) => {
        hosts.forEach((h, i) => {
          for (const message of validateAllowHost(h)) {
            ctx.addIssue({ code: "custom", path: [i], message: `${h}: ${message}` });
          }
        });
        if (new Set(hosts).size !== hosts.length) {
          ctx.addIssue({ code: "custom", message: "allowHosts must not contain duplicates" });
        }
      })
      .optional(),
  })
  .strict();

export type CloudNetworkSetting = z.infer<typeof CloudNetworkSettingSchema>;

/** What an invalid stored `cloudNetwork` reads as: the allowlist with no host (never wider). */
export const invalidCloudNetwork = (): CloudNetworkSetting => ({
  mode: "allowlist",
  allowHosts: [],
});

/**
 * The org's auto-mode switch (auto mode spec §4.3): `allowed` or `off`; absent follows the
 * platform's `devices.autoMode`. An invalid stored value reads as `off` (narrower, never wider).
 */
export const AutoModeSetting = z.enum(["allowed", "off"]) satisfies z.ZodType<DevicesAutoMode>;

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
  /** The org's auto-mode switch (auto mode spec §4.3); absent follows the platform. */
  autoMode: AutoModeSetting.optional().catch("off"),
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
     * The org's auto-mode switch; null clears it (follow the platform). `allowed` while the
     * platform is `off` -> 400 `org.auto_mode_not_allowed`.
     */
    autoMode: AutoModeSetting.nullable().optional(),
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

/** The deployment defaults the settings page shows for "follow the platform" (`GET` returns them). */
export interface OrgSettingsDeployment {
  /** The platform's auto-mode switch and where it comes from. */
  autoMode: DevicesAutoModeView;
  /**
   * The deployment's default cloud network: `open` (the normal default; `allowlist` when
   * `sandbox.limits.egress` is `none`, the kill switch) and the host list an allowlist starts from.
   */
  cloudNetwork: { mode: "open" | "allowlist"; allowHosts: string[] };
}

/** Compare by value (`cloudNetwork` is an object); the schema fixes the key order. */
const sameSettings = (a: OrgSettings, b: OrgSettings): boolean =>
  JSON.stringify(OrgSettingsSchema.parse(a)) === JSON.stringify(OrgSettingsSchema.parse(b));

const asObject = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** 把存储的 jsonb 解析为设置（宽松，见 {@link OrgSettingsSchema}）。 */
export function parseOrgSettings(raw: unknown): OrgSettings {
  return OrgSettingsSchema.parse(asObject(raw));
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

/** Whether a stored settings object holds an `autoMode` this version reads as `off`. */
export function invalidStoredAutoMode(raw: unknown): boolean {
  const v = asObject(raw).autoMode;
  return v !== undefined && !AutoModeSetting.safeParse(v).success;
}

/** Whether a stored settings object holds a `cloudNetwork` this version reads as an empty allowlist. */
export function invalidStoredCloudNetwork(raw: unknown): boolean {
  const v = asObject(raw).cloudNetwork;
  return v !== undefined && !CloudNetworkSettingSchema.safeParse(v).success;
}

/** 组织设置服务：读取与修改（修改需 `org.update`，锁内实时复核角色，写审计）。 */
@Injectable()
export class OrgSettingsService {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(OrgLock) private readonly orgLock: OrgLock,
    /**
     * The deployment config: `sandbox.limits` and the platform's auto-mode switch
     * (`devices.autoMode`; the org may follow it, never exceed it).
     */
    @Inject(KernelConfigService)
    private readonly config: Pick<KernelConfigService, "get" | "fieldSource">,
    @Optional() @Inject(KERNEL_LOGGER) private readonly log?: KernelLogger,
  ) {}

  /** Parses stored settings, warning when an invalid `autoMode` narrows to `off` or an invalid
   * `cloudNetwork` to an empty allowlist. */
  private parseStored(orgId: string, raw: unknown): OrgSettings {
    if (invalidStoredAutoMode(raw)) {
      this.log?.warn("org settings: stored autoMode is invalid; it reads as off", { orgId });
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
    return {
      autoMode: await readDevicesAutoMode(this.db.db, this.config, this.log),
      cloudNetwork:
        lim.egress === "none"
          ? { mode: "allowlist", allowHosts: [] }
          : { mode: "open", allowHosts: [...lim.allowHosts] },
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

  /** The refusals of {@link update} that need no read of the org (the Platform tool's precheck). */
  async check(patch: OrgSettingsPatch): Promise<void> {
    // turning auto mode on where the platform turned it off is wider than the platform allows
    if (patch.autoMode === "allowed") {
      const platform = await readDevicesAutoMode(this.db.db, this.config, this.log);
      if (platform.mode === "off") {
        throw autoModeNotAllowed("The platform does not allow auto mode");
      }
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
     * `onlyNarrows` (the Platform tool, API tokens): refuse an `autoMode` or `cloudNetwork`
     * change that widens (see {@link assertOnlyNarrows}); only a person in a session widens.
     */
    opts?: { onlyNarrows?: boolean },
  ): Promise<OrgSettings> {
    await this.check(patch);
    return this.updateIn(orgId, patch, actorAccountId, actorTokenId, auditDetail, opts);
  }

  /**
   * Refuses a patch that widens the org's sandbox (auto mode spec §4.3: only a person widens it,
   * never the Platform tool or an API token):
   * - `autoMode`: `allowed` where the organization runs `off` (an absent value follows the
   *   platform); clearing it follows the platform too, never wider than the platform allows;
   * - `cloudNetwork`: `open` where the network is the allowlist, or a host the current allowlist
   *   does not have (the deployment's `sandbox.limits.allowHosts` when the org gives none).
   *   `cloudNetwork.allowHosts` is also the local sandbox-mode ceiling (`orgAllowedDomains` in
   *   `sandbox/modes.ts` becomes `deviceLimits.localAllowedDomains`, which the device intersects
   *   with its own list): an org with no `cloudNetwork` still caps its local devices at the
   *   deployment's list, so an allowlist carrying a host outside that list raises their ceiling
   *   even though `open` itself reaches every public address. Switching from `open` is therefore
   *   only a narrowing when every host is already in the deployment's list; the allowed change
   *   always narrows the cloud network too (spec §4.2, §4.3).
   */
  async assertOnlyNarrows(before: OrgSettings, patch: OrgSettingsPatch): Promise<void> {
    if (patch.autoMode !== undefined) {
      const platform = await readDevicesAutoMode(this.db.db, this.config, this.log);
      const next = patch.autoMode === null ? platform.mode : patch.autoMode;
      if ((before.autoMode ?? platform.mode) !== "allowed" && next === "allowed") {
        throw autoModeNotAllowed(
          "Turning auto mode on needs a person in the organization settings.",
        );
      }
    }
    if (patch.cloudNetwork !== undefined) {
      const lim = this.config.get().sandbox.limits;
      const defaultMode = lim.egress === "none" ? "allowlist" : "open";
      const defaultHosts = lim.egress === "none" ? [] : [...lim.allowHosts];
      const prev = before.cloudNetwork;
      const next = patch.cloudNetwork ?? undefined;
      const modeOf = (v: typeof prev) => v?.mode ?? defaultMode;
      const hostsOf = (v: typeof prev): string[] => v?.allowHosts ?? defaultHosts;
      const nextMode = next?.mode ?? defaultMode;
      const widens =
        nextMode === "open"
          ? modeOf(prev) !== "open"
          : !hostsOf(next).every((h) => hostsOf(prev).includes(h));
      if (widens) {
        throw new ApiError(
          "org.sandbox_egress_not_allowed",
          "Widening the cloud network needs a person in the organization settings.",
        );
      }
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
    if (opts?.onlyNarrows) await this.assertOnlyNarrows(before, patch);
    const changes = Object.fromEntries(
      Object.entries(patch)
        .filter(([, v]) => v !== undefined)
        // null clears autoMode / cloudNetwork / wakeOnBackgroundTask: follow the deployment again
        .map(([k, v]) => [k, v === null ? undefined : v]),
    ) as Partial<OrgSettings>;
    const arrangementPatch = patch.uiArrangement;
    delete changes.uiArrangement;
    delete changes.scheduledTasks;
    const after: OrgSettings = { ...before, ...changes };
    if (patch.scheduledTasks !== undefined) {
      after.scheduledTasks = ScheduledTasksSettingsSchema.parse({
        ...before.scheduledTasks,
        ...Object.fromEntries(
          Object.entries(patch.scheduledTasks).filter(([, v]) => v !== undefined),
        ),
      });
    }
    if (arrangementPatch !== undefined) {
      after.uiArrangement = mergeArrangement(before.uiArrangement, arrangementPatch);
      if (Object.keys(after.uiArrangement).length === 0) delete after.uiArrangement;
    }
    if (after.autoMode === undefined) delete after.autoMode;
    if (after.cloudNetwork === undefined) delete after.cloudNetwork;
    if (after.wakeOnBackgroundTask === undefined) delete after.wakeOnBackgroundTask;
    if (after.timeZone === undefined) delete after.timeZone;
    if (after.theme === undefined) delete after.theme;
    if (after.uiArrangement === undefined) delete after.uiArrangement;
    if (after.gitGateway === undefined) delete after.gitGateway;
    if (sameSettings(before, after)) return before;
    // Lock order: the org row (orgLock above), then the theme's catalog item and its row FOR
    // SHARE (assertThemeOnIn), then the check, so no scope writer changes what it read first
    if (patch.theme?.id != null && patch.theme.id !== before.theme?.id) {
      await assertThemeOnIn(this.db.db, orgId, patch.theme.id);
    }
    // Merge with the stored value: keep the keys this version does not know (a cleared autoMode /
    // cloudNetwork is not kept)
    const {
      autoMode: _oldAutoMode,
      cloudNetwork: _oldNetwork,
      wakeOnBackgroundTask: _oldWake,
      timeZone: _oldZone,
      theme: _oldTheme,
      uiArrangement: _oldArrangement,
      scheduledTasks: _oldScheduled,
      ...rest
    } = stored;
    await this.db
      .updateTable("orgs")
      .set({ settings: JSON.stringify({ ...rest, ...after }) })
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
    return after;
  }
}

/**
 * The one {@link OrgSettingsService}: the orgs module re-exports it, and the catalog imports it
 * directly (approving a network request writes the org's cloud network) without a cycle through
 * OrgsModule.
 */
@Module({
  imports: [OrgLockModule],
  providers: [OrgSettingsService],
  exports: [OrgSettingsService],
})
export class OrgSettingsModule {}
