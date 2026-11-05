import type { LocalizedName } from "@capybara-hq/plugin-sdk";
import { Controller, Get, Inject, Param, Put } from "@nestjs/common";
import { z } from "zod";
import { ExtensionDisplayNames } from "../extensions/display-name.js";
import { OrgExtensionConfigs, type OrgExtensionView } from "../extensions/org-config.js";
import {
  CurrentPrincipal,
  type Principal,
  patTokenId,
  requireUser,
} from "../identity/principal.js";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import { ZBody } from "../infra/validation/zod-params.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import { OrgExtensionSwitch } from "./org-extension-switch.js";
import type { UninstallPreview } from "./plugin-install.js";

const PutBody = z
  .object({
    enabled: z.boolean().optional(),
    config: z.record(z.string(), z.unknown()).optional(),
    force: z.boolean().optional(),
    /** The hash of the plugin uninstall preview, to confirm switching the extension's plugin off. */
    confirm: z.string().optional(),
  })
  .strict();

class OrgExtensionPutBody extends createZodDto(PutBody, "OrgExtensionPutBody") {}

/** One extension of the org list: the org view plus the plugin's display name. */
export type OrgExtensionItem = OrgExtensionView & { displayName: LocalizedName | null };

/**
 * Org-level extension enablement and config (`/api/v1/orgs/:orgId/extensions`); responses echo only
 * non-secret config and whether each secret is set.
 */
@Controller("api/v1/orgs/:orgId/extensions")
export class OrgExtensionConfigsController {
  constructor(
    @Inject(OrgExtensionConfigs) private readonly configs: OrgExtensionConfigs,
    @Inject(ExtensionDisplayNames) private readonly displayNames: ExtensionDisplayNames,
    @Inject(OrgExtensionSwitch) private readonly extSwitch: OrgExtensionSwitch,
  ) {}

  /** The org's extensions (also the channel plugin options: those providing `channel@1`). */
  @Get()
  @OrgAction("org.extensions.manage")
  async list(@CurrentOrg() org: OrgContext): Promise<{ extensions: OrgExtensionItem[] }> {
    const views = await this.configs.list(org.orgId);
    const names = await this.displayNames.many(views.map((v) => v.plugin));
    return {
      extensions: views.map((v) => ({ ...v, displayName: names.get(v.plugin) ?? null })),
    };
  }

  /**
   * Writes enablement and / or config; see {@link OrgExtensionSwitch.put} for how `enabled` follows
   * the extension's plugin (off answers `{ preview, confirm }` until `confirm` carries the hash).
   */
  @Put(":extension")
  @OrgAction("org.extensions.manage")
  async put(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("extension") extension: string,
    @ZBody(OrgExtensionPutBody) body: z.infer<typeof PutBody>,
  ): Promise<{ extension: OrgExtensionItem } | { preview: UninstallPreview; confirm: string }> {
    const p = requireUser(principal);
    const r = await this.extSwitch.put(org.orgId, p.account.id, extension, body, patTokenId(p));
    if (r.kind === "preview") return { preview: r.preview, confirm: r.confirm };
    return { extension: { ...r.view, displayName: await this.displayNames.get(r.view.plugin) } };
  }
}
