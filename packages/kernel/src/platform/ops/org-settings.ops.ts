import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";
import { OrgSettingsPatchSchema, OrgSettingsService } from "../../orgs/settings.service.js";
import { defineOperation } from "../operation.js";
import { PlatformOperations } from "../registry.js";
import { precheckBy, viaAgent } from "./errors.js";

const PLATFORM_TOOL_NOTE: Record<string, string> = {
  off: "The Platform tool is now off for this org: from the next call on, no Platform operation is available, including this one. An org admin can switch it back on in the organization settings on the web.",
  "read-only":
    "The Platform tool is now read-only for this org: from the next call on, writes are unavailable and only reads run. An org admin can change it in the organization settings on the web.",
};

const show = (v: unknown): string => (v === null ? "default" : JSON.stringify(v));

/**
 * Org settings operations of the `Platform` tool (spec §14): read the settings every member sees,
 * and change them (org admins). The `platformTool` setting is included. A write that turns it
 * off or to read-only is allowed once the person confirms it, and it applies to later calls: the
 * tool reads the setting on every call, so the current run is cut off from the next call on. The
 * result and the card say so.
 */
@Injectable()
export class OrgSettingsOperations implements OnModuleInit {
  constructor(
    @Inject(PlatformOperations) private readonly registry: PlatformOperations,
    @Inject(OrgSettingsService) private readonly settings: OrgSettingsService,
  ) {}

  onModuleInit(): void {
    this.registry.register([
      defineOperation({
        id: "org-settings.get",
        description:
          "Read this org's settings: toolSearch, locale, sandboxToolPolicy, platformTool (on, read-only or off), sandboxEgress and wakeOnBackgroundTask (absent means it follows the deployment), theme (the org's default theme id, null or absent following the platform, and personal: allowed or locked), the deployment's sandbox egress default and the sandbox cpu / memory limits in effect.",
        input: z.object({}).strict(),
        example: {},
        authz: { orgAction: "org.read" },
        mirrors: ["GET /api/v1/orgs/:orgId/settings"],
        confirm: "read",
        run: async (_input, ctx) => ({
          settings: await this.settings.get(ctx.orgId),
          deployment: this.settings.deployment(),
          sandboxLimits: await this.settings.sandboxLimits(ctx.orgId),
        }),
      }),
      defineOperation({
        id: "org-settings.update",
        description:
          "Change this org's settings (org admins). Give only the settings to change; null clears sandboxEgress or wakeOnBackgroundTask so they follow the deployment again. theme: { id, personal } sets the org's default theme (a theme id from themes.list, or null to follow the platform) and whether members may pick their own (allowed) or not (locked); null clears it. Setting platformTool to off or read-only takes effect from the next call and cuts this Platform tool off in the org, so say so before asking; an org admin switches it back on in the web settings.",
        input: OrgSettingsPatchSchema.refine((i) => Object.values(i).some((v) => v !== undefined), {
          message: "give at least one setting",
        }),
        example: { toolSearch: "on" },
        authz: { orgAction: "org.update" },
        mirrors: ["PATCH /api/v1/orgs/:orgId/settings"],
        confirm: "org",
        errors: [
          {
            code: "org.sandbox_egress_not_allowed",
            next: "This deployment disables sandbox network access, so the org can only set sandboxEgress to none; ask the super admin to change sandbox.limits.egress.",
          },
          {
            code: "theme.not_available",
            next: "Pick a theme id that themes.list shows for this org, or null to follow the platform.",
          },
          {
            code: "validation_failed",
            next: "Fix the setting as the message says (org-settings.get shows the current values).",
          },
        ],
        precheck: (i) => precheckBy(async () => this.settings.check(i)),
        summary: (i) => {
          const parts = Object.entries(i)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => `${k} → ${show(v)}`);
          const warn = i.platformTool === "off" || i.platformTool === "read-only";
          return {
            zh: `修改组织设置：${parts.join("，")}${
              warn
                ? "（之后智能体不能再用平台工具" + (i.platformTool === "off" ? "" : "写入") + "）"
                : ""
            }`,
            en: `Update the org settings: ${parts.join(", ")}${
              warn
                ? `; from the next call the Platform tool is ${
                    i.platformTool === "off" ? "off" : "read-only"
                  } in this org`
                : ""
            }`,
          };
        },
        run: async (input, ctx) => {
          const settings = await this.settings.update(
            ctx.orgId,
            input,
            ctx.actorAccountId,
            undefined,
            viaAgent("org-settings.update", ctx),
          );
          const note =
            input.platformTool === undefined
              ? undefined
              : PLATFORM_TOOL_NOTE[settings.platformTool];
          return { settings, ...(note !== undefined && { note }) };
        },
      }),
    ]);
  }
}
