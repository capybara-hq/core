import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";
import { OrgSettingsPatchSchema, OrgSettingsService } from "../../orgs/settings.service.js";
import { ThemesService } from "../../themes/themes.service.js";
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
    @Inject(ThemesService) private readonly themes: ThemesService,
  ) {}

  onModuleInit(): void {
    this.registry.register([
      defineOperation({
        id: "org-settings.get",
        description:
          "Read this org's settings: toolSearch, locale, sandboxToolPolicy, platformTool (on, read-only or off), autoMode (allowed or off: whether the org's devices may run in auto mode; absent follows the deployment's switch, and the org may never exceed it), cloudNetwork (the network of a cloud device in sandbox mode: open, or allowlist with its hosts; open means any public host, while loopback, private and cloud metadata addresses stay blocked), wakeOnBackgroundTask (absent means it follows the deployment), theme (the org's default theme id, null or absent following the platform, and personal: allowed or locked), uiArrangement (per list slot, the extension contributions the org hides and their order; per single slot, the contribution that replaces the built-in as use, null for the built-in; a slot not listed follows the platform), the deployment's auto-mode switch and cloud-network defaults, and the sandbox cpu / memory limits in effect.",
        input: z.object({}).strict(),
        example: {},
        authz: { orgAction: "org.read" },
        mirrors: ["GET /api/v1/orgs/:orgId/settings"],
        confirm: "read",
        run: async (_input, ctx) => ({
          settings: await this.settings.get(ctx.orgId),
          deployment: await this.settings.deployment(),
          sandboxLimits: await this.settings.sandboxLimits(ctx.orgId),
        }),
      }),
      defineOperation({
        id: "org-settings.update",
        description:
          "Change this org's settings (org admins). Give only the settings to change; null clears autoMode, cloudNetwork or wakeOnBackgroundTask so they follow the deployment again (refused when the deployment value is wider than what this tool may set). autoMode (allowed or off; the platform must allow it) and cloudNetwork ({ mode: open | allowlist, allowHosts? }, replaced whole, hosts left out following the deployment's list) may only narrow the org's devices here: turning auto mode on where the org has it off, switching the cloud network from allowlist to open, or adding a network host is refused and needs a person in the organization settings on the web. theme: { id, personal } sets the org's default theme (a theme id from themes.list, or null to follow the platform) and whether members may pick their own (allowed) or not (locked); null clears it. uiArrangement: { <slot>: { hidden, order } } (a list slot) or { <slot>: { use } } (a single slot: shell.brand, conversation.empty, conversation.composer.frame) replaces that slot's entry, where hidden, order and use name contribution keys <extension>/<contribution> (hidden ones are not listed in the web UI but their pages still open by URL; use null is the built-in); null for a slot makes it follow the platform again; platform.page is refused. Setting platformTool to off or read-only takes effect from the next call and cuts this Platform tool off in the org, so say so before asking; an org admin switches it back on in the web settings.",
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
            next: "Through this tool the org's cloud network may only be narrowed: an open network may become an allowlist of hosts the deployment already allows, and the allowlist may lose hosts, but neither may add a host or switch back to open. To widen it, ask an org admin to change it in the organization settings on the web.",
          },
          {
            code: "org.auto_mode_not_allowed",
            next: "Through this tool the org's auto mode may only be turned off, never on (the platform may turn it off too; org-settings.get shows both); to allow it, ask an org admin to change it in the organization settings on the web.",
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
        precheck: (i, ctx) =>
          precheckBy(async () => {
            await this.settings.check(i);
            await this.settings.assertOnlyNarrows(await this.settings.get(ctx.orgId), i);
          }),
        summary: async (i, ctx) => {
          const { theme, ...rest } = i;
          const parts = Object.entries(rest)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => `${k} → ${show(v)}`);
          const zhParts = [...parts];
          const enParts = [...parts];
          if (theme !== undefined) {
            // the theme by its name when it is on in this org; any other id is shown as given
            const name = theme?.id == null ? null : await this.themes.nameIn(ctx.orgId, theme.id);
            if (theme === null) {
              zhParts.push("theme → 清除（跟随平台，允许个人选择）");
              enParts.push("theme → cleared (follow the platform, personal picks allowed)");
            } else {
              const zh = theme.id === null ? "跟随平台" : (name?.zh ?? theme.id);
              const en = theme.id === null ? "follow the platform" : (name?.en ?? theme.id);
              zhParts.push(
                `theme → ${zh}（个人选择：${theme.personal === "locked" ? "锁定" : "允许"}）`,
              );
              enParts.push(
                `theme → ${en} (personal picks ${theme.personal === "locked" ? "locked" : "allowed"})`,
              );
            }
          }
          const warn = i.platformTool === "off" || i.platformTool === "read-only";
          return {
            zh: `修改组织设置：${zhParts.join("，")}${
              warn ? `（之后智能体不能再用平台工具${i.platformTool === "off" ? "" : "写入"}）` : ""
            }`,
            en: `Update the org settings: ${enParts.join(", ")}${
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
            // a person widens auto mode or the cloud network, never an agent (auto mode spec §4.3)
            { onlyNarrows: true },
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
