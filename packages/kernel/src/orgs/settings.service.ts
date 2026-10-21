import { type SandboxLimits, validateAllowHost } from "@capybara-hq/plugin-sdk";
import { z } from "zod";
import type { KernelConfig } from "../config/schema.js";
import type { KernelDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { audit } from "../identity/audit.js";
import { lockOrgAndAuthorize } from "./org-lock.js";

/**
 * 组织设置（`capybara.orgs.settings` jsonb）。读取宽松：缺失或非法的字段按默认值，未知键保留不动
 * （更新时与存量合并），新版本加字段不需要迁移。
 * - `toolSearch`：工具超过阈值时是否改用目录 + `tool_search`（D11，默认 on）。
 * - `locale`：组织默认语言（`zh` / `en`，默认 en），机器人在 IM 里说的固定话术按它选择。
 * - `sandboxToolPolicy`：沙箱工具的默认策略（M5 T8，默认 allow）。为 `ask` 时除只读的
 *   `sandbox_read` / `sandbox_glob` / `sandbox_grep` 外都需要审批（执行时实时读取）。
 * - `sandboxEgress`：组织的沙箱出站（Ruling M19 / D6），缺省跟随部署的 `sandbox.limits.egress` + `allowHosts`。
 *   见 {@link effectiveSandboxEgress}。存量值非法时按 `none` 读（宁可断网，不悄悄放宽到部署默认）。
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

export const OrgSettingsSchema = z.object({
  toolSearch: z.enum(["on", "off"]).default("on").catch("on"),
  locale: z.enum(["zh", "en"]).default("en").catch("en"),
  sandboxToolPolicy: z.enum(["allow", "ask"]).default("allow").catch("allow"),
  sandboxEgress: SandboxEgressSettingSchema.optional().catch({ mode: "none" }),
});

export type OrgSettings = z.infer<typeof OrgSettingsSchema>;

/** PATCH 体：只改给出的字段；未知字段 → 400。 */
export const OrgSettingsPatchSchema = z
  .object({
    toolSearch: z.enum(["on", "off"]).optional(),
    locale: z.enum(["zh", "en"]).optional(),
    sandboxToolPolicy: z.enum(["allow", "ask"]).optional(),
    /** null 清除（恢复跟随部署默认）。 */
    sandboxEgress: SandboxEgressSettingSchema.nullable().optional(),
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
export async function readOrgSettings(db: KernelDb, orgId: string): Promise<OrgSettings> {
  const row = await db
    .selectFrom("orgs")
    .select("settings")
    .where("id", "=", orgId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  return parseOrgSettings(row?.settings);
}

/** 组织设置服务：读取与修改（修改需 `org.update`，锁内实时复核角色，写审计）。 */
export class OrgSettingsService {
  constructor(
    private readonly db: KernelDb,
    /** 部署配置（校验 `sandboxEgress` 不超出部署）；省略视为部署出站 `allowlist` + 空白名单。 */
    private readonly config?: () => Pick<KernelConfig, "sandbox">,
  ) {}

  /** 部署默认值（设置页展示「跟随部署」时的实际取值）。 */
  deployment(): OrgSettingsDeployment {
    const lim = this.config?.().sandbox.limits;
    return {
      sandboxEgress: { mode: lim?.egress ?? "allowlist", allowHosts: [...(lim?.allowHosts ?? [])] },
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

  async update(
    orgId: string,
    patch: OrgSettingsPatch,
    actorAccountId: string,
    actorTokenId?: string,
  ): Promise<OrgSettings> {
    if (
      patch.sandboxEgress?.mode === "allowlist" &&
      this.deployment().sandboxEgress.mode === "none"
    ) {
      throw new ApiError(
        "org.sandbox_egress_not_allowed",
        "This deployment disables sandbox network access (sandbox.limits.egress is none); an organization can only set sandboxEgress to none",
      );
    }
    return this.db.transaction().execute(async (trx) => {
      await lockOrgAndAuthorize(trx, orgId, actorAccountId, "org.update");
      const row = await trx
        .selectFrom("orgs")
        .select("settings")
        .where("id", "=", orgId)
        .executeTakeFirstOrThrow();
      const stored = asObject(row.settings);
      const before = parseOrgSettings(stored);
      const changes = Object.fromEntries(
        Object.entries(patch)
          .filter(([, v]) => v !== undefined)
          // null 清除 sandboxEgress：恢复跟随部署默认
          .map(([k, v]) => [k, v === null ? undefined : v]),
      ) as Partial<OrgSettings>;
      const after: OrgSettings = { ...before, ...changes };
      if (after.sandboxEgress === undefined) delete after.sandboxEgress;
      if (sameSettings(before, after)) return before;
      // 与存量合并：保留本版本不认识的键（清除的 sandboxEgress 不留在存量里）
      const { sandboxEgress: _old, ...rest } = stored;
      await trx
        .updateTable("orgs")
        .set({ settings: JSON.stringify({ ...rest, ...after }) })
        .where("id", "=", orgId)
        .execute();
      await audit(trx, {
        actorAccountId,
        ...(actorTokenId !== undefined && { actorTokenId }),
        orgId,
        action: "org.settings_updated",
        target: orgId,
        detail: { before, after },
      });
      return after;
    });
  }
}
