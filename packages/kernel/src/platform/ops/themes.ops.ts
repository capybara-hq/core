import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";
import { ThemesService } from "../../themes/themes.service.js";
import { defineOperation } from "../operation.js";
import { PlatformOperations } from "../registry.js";

/**
 * Theme operations of the `Platform` tool (themes spec §9): the org's theme listing. Setting a
 * theme goes through the settings operations (`platform.set-preferences`, `org-settings.update`,
 * `admin.update-settings`).
 */
@Injectable()
export class ThemesOperations implements OnModuleInit {
  constructor(
    @Inject(PlatformOperations) private readonly registry: PlatformOperations,
    @Inject(ThemesService) private readonly themes: ThemesService,
  ) {}

  onModuleInit(): void {
    this.registry.register([
      defineOperation({
        id: "themes.list",
        description:
          "List the themes on in this org (id, version, name, schemes, logo, decoration (the sign-in page background pattern: dither or none), background (the page background color per scheme) and the bg / panel / ink / accent swatches per scheme), the theme in effect for you here (resolved; null is the built-in theme) and the org's setting (its default theme id, null following the platform, and whether personal picks are allowed or locked), and avatars: the agent avatar presets of the org's default theme (hidden: the built-in preset ids it does not offer; presets: its own presets, each with a key, a name and a url). Use a preset key as the avatar id with agents.update-profile. Use a theme id with platform.set-preferences to change your own theme, or with org-settings.update to change the org's default.",
        input: z.object({}).strict(),
        example: {},
        authz: { orgAction: "org.read" },
        mirrors: ["GET /api/v1/orgs/:orgId/themes"],
        confirm: "read",
        run: async (_input, ctx) => this.themes.forOrg(ctx.orgId, ctx.actorAccountId),
      }),
    ]);
  }
}
