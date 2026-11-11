import { type SandboxLimits, validateAllowHost } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { audit } from "../identity/audit.js";
import { readSandboxLimitOverride, type SandboxLimitOverride } from "../identity/settings.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { assertThemeOnIn } from "../themes/theme-state.js";
import { IanaTimeZone } from "../time-zone.js";
import {
  mergeArrangement,
  OrgUiArrangementPatchSchema,
  UiArrangementSchema,
} from "../ui/arrangement.js";
import { OrgLock } from "./org-lock.js";

/**
 * 组织设置（`capybara.orgs.settings` jsonb）。读取宽松：缺失或非法的字段按默认值，未知键保留不动
 * （更新时与存量合并），新版本加字段不需要迁移。
 * - `toolSearch`：工具超过阈值时是否改用目录 + `ToolSearch`（D11，默认 on）。
 * - `locale`：组织默认语言（`zh` / `en`，默认 en），机器人在 IM 里说的固定话术按它选择。
 * - `sandboxToolPolicy`：沙箱工具的默认策略（M5 T8，默认 allow）。为 `ask` 时除只读的
 *   `Read` / `Glob` / `Grep` 外都需要审批（执行时实时读取）。
 * - `wakeOnBackgroundTask`：组织对 `runtime.wakeOnBackgroundTask` 的覆盖（缺省跟随部署），见 {@link effectiveWakeOnBackgroundTask}。
 * - `sandboxEgress`：组织的沙箱出站（Ruling M19 / D6），缺省跟随部署的 `sandbox.limits.egress` + `allowHosts`。
 *   见 {@link effectiveSandboxEgress}。存量值非法时按 `none` 读（宁可断网，不悄悄放宽到部署默认）。
 * - `platformTool`: the `Platform` builtin for the whole org (Platform tool spec §3): `on`,
 *   `read-only` (writes listed as unavailable) or `off` (default `on`).
 * - `timeZone`: the org's default time zone (IANA; absent = UTC) for senders without one of their
 *   own (run context spec §3.3); an invalid stored value reads as absent.
 * - `theme`: the org's default theme and whether members may pick their own (themes spec §7);
 *   absent (or an invalid stored value) = follow the platform, personal picks allowed.
 * - `uiArrangement`: per slot, the extension contributions the org hides and their order (UI slots
 *   spec §5); a slot with no entry follows the platform's; an invalid stored value reads as absent.
 */

/** 组织沙箱出站白名单的主机数上限。 */
export const ORG_SANDBOX_ALLOW_HOSTS_MAX = 200;

/**
 * 组织的沙箱出站设置：`none`（只有回环），或 `allowlist`。`allowHosts` 给出时**替换**部署的白名单
 * （组织可以去掉预置项、也可以加别的主机），省略时沿用部署的白名单。没有 `open`：组织不能比部署放得更开。
 */
export const SandboxEgressSettingSchema = z
  .object({
    mode: z.enum(["none", "allowlist"]),
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

export type SandboxEgressSetting = z.infer<typeof SandboxEgressSettingSchema>;

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

export const OrgSettingsSchema = z.object({
  toolSearch: z.enum(["on", "off"]).default("on").catch("on"),
  locale: z.enum(["zh", "en"]).default("en").catch("en"),
  sandboxToolPolicy: z.enum(["allow", "ask"]).default("allow").catch("allow"),
  platformTool: z.enum(["on", "read-only", "off"]).default("on").catch("on"),
  sandboxEgress: SandboxEgressSettingSchema.optional().catch({ mode: "none" }),
  /** Overrides `runtime.wakeOnBackgroundTask`; absent follows the deployment. */
  wakeOnBackgroundTask: z.boolean().optional().catch(undefined),
  /** The org's default time zone (run context spec §3.3); absent = UTC. */
  timeZone: IanaTimeZone.optional().catch(undefined),
  /** The org's default theme and personal lock (themes spec §7); absent = {@link DEFAULT_ORG_THEME}. */
  theme: OrgThemeSettingSchema.optional().catch(undefined),
  /** Hidden and ordered extension contributions per slot; absent = follow the platform. */
  uiArrangement: UiArrangementSchema.optional().catch(undefined),
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
    /** null 清除（恢复跟随部署默认）。 */
    sandboxEgress: SandboxEgressSettingSchema.nullable().optional(),
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

/** 部署的沙箱出站（`sandbox.limits.egress` + `allowHosts`）。 */
export type DeploymentEgress = Pick<SandboxLimits, "egress" | "allowHosts">;

/**
 * 组织实际生效的沙箱出站：没有组织设置 → 部署默认；`none` → 只有回环；`allowlist` → 组织的白名单
 * （省略时用部署的），但部署是 `none` 时仍为 `none`（组织永远不比部署放得更开，部署改成 none 后存量设置也随之收紧）。
 */
export function effectiveSandboxEgress(
  deployment: DeploymentEgress,
  org: SandboxEgressSetting | undefined,
): DeploymentEgress {
  if (org === undefined)
    return { egress: deployment.egress, allowHosts: [...deployment.allowHosts] };
  if (org.mode === "none" || deployment.egress === "none")
    return { egress: "none", allowHosts: [] };
  return { egress: "allowlist", allowHosts: [...(org.allowHosts ?? deployment.allowHosts)] };
}

/** Whether a finished background task wakes an idle conversation: the org's setting, else the deployment's. */
export function effectiveWakeOnBackgroundTask(
  deployment: boolean,
  org: OrgSettings["wakeOnBackgroundTask"],
): boolean {
  return org ?? deployment;
}

/**
 * 组织实际生效的沙箱限额（C19 / Ruling M16）：超级管理员的覆盖（部署设置 `sandboxLimitOverrides[orgId]`）
 * 给出的 cpu / memoryMb 替换部署默认，未给的项、disk 与出站沿用 `deployment`。只在创建沙箱时读取。
 */
export function effectiveSandboxLimits(
  deployment: SandboxLimits,
  override: { cpu?: number | undefined; memoryMb?: number | undefined } | undefined,
): SandboxLimits {
  return {
    ...deployment,
    allowHosts: [...deployment.allowHosts],
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

/** 设置页展示用的部署默认值（`GET` 一并返回）。 */
export interface OrgSettingsDeployment {
  sandboxEgress: { mode: SandboxLimits["egress"]; allowHosts: string[] };
}

/** 按值比较（`sandboxEgress` 是对象）；键序由 schema 固定。 */
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

/** 组织设置服务：读取与修改（修改需 `org.update`，锁内实时复核角色，写审计）。 */
@Injectable()
export class OrgSettingsService {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(OrgLock) private readonly orgLock: OrgLock,
    /** The deployment config (`sandboxEgress` may not exceed the deployment's). */
    @Inject(KernelConfigService) private readonly config: Pick<KernelConfigService, "get">,
  ) {}

  /** 部署默认值（设置页展示「跟随部署」时的实际取值）。 */
  deployment(): OrgSettingsDeployment {
    const lim = this.config.get().sandbox.limits;
    return {
      sandboxEgress: { mode: lim.egress, allowHosts: [...lim.allowHosts] },
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
    return parseOrgSettings(row.settings);
  }

  /** The refusals of {@link update} that need no read of the org (the Platform tool's precheck). */
  check(patch: OrgSettingsPatch): void {
    if (
      patch.sandboxEgress?.mode === "allowlist" &&
      this.deployment().sandboxEgress.mode === "none"
    ) {
      throw new ApiError(
        "org.sandbox_egress_not_allowed",
        "This deployment disables sandbox network access (sandbox.limits.egress is none); an organization can only set sandboxEgress to none",
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
  ): Promise<OrgSettings> {
    this.check(patch);
    return this.updateIn(orgId, patch, actorAccountId, actorTokenId, auditDetail);
  }

  @Transactional()
  private async updateIn(
    orgId: string,
    patch: OrgSettingsPatch,
    actorAccountId: string,
    actorTokenId: string | undefined,
    auditDetail: Record<string, unknown> | undefined,
  ): Promise<OrgSettings> {
    await this.orgLock.lockAndAuthorize(orgId, actorAccountId, "org.update");
    const row = await this.db
      .selectFrom("orgs")
      .select("settings")
      .where("id", "=", orgId)
      .executeTakeFirstOrThrow();
    const stored = asObject(row.settings);
    const before = parseOrgSettings(stored);
    const changes = Object.fromEntries(
      Object.entries(patch)
        .filter(([, v]) => v !== undefined)
        // null clears sandboxEgress / wakeOnBackgroundTask: follow the deployment default again
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
    if (after.sandboxEgress === undefined) delete after.sandboxEgress;
    if (after.wakeOnBackgroundTask === undefined) delete after.wakeOnBackgroundTask;
    if (after.timeZone === undefined) delete after.timeZone;
    if (after.theme === undefined) delete after.theme;
    if (after.uiArrangement === undefined) delete after.uiArrangement;
    if (sameSettings(before, after)) return before;
    // Lock order: the org row (orgLock above), then the theme's catalog item and its row FOR
    // SHARE (assertThemeOnIn), then the check, so no scope writer changes what it read first
    if (patch.theme?.id != null && patch.theme.id !== before.theme?.id) {
      await assertThemeOnIn(this.db.db, orgId, patch.theme.id);
    }
    // 与存量合并：保留本版本不认识的键（清除的 sandboxEgress 不留在存量里）
    const {
      sandboxEgress: _old,
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
