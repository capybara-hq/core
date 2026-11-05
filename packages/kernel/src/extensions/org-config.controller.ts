import type { LocalizedName } from "@capybara-hq/plugin-sdk";
import { Controller, Get, Inject, Param, Put } from "@nestjs/common";
import { z } from "zod";
import { OrgCatalogService } from "../catalog/org-catalog.service.js";
import type { UninstallPreview } from "../catalog/plugin-install.js";
import {
  CurrentPrincipal,
  type Principal,
  patTokenId,
  requireUser,
} from "../identity/principal.js";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import { ZBody } from "../infra/validation/zod-params.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import { ExtensionDisplayNames } from "./display-name.js";
import { OrgExtensionConfigs, type OrgExtensionView } from "./org-config.js";

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
    @Inject(OrgCatalogService) private readonly catalog: OrgCatalogService,
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
   * Writes enablement and / or config. For an extension that ships in a catalog plugin, `enabled` is
   * the plugin's org switch ({@link OrgCatalogService.setSwitch}): switching off without `confirm`
   * answers `{ preview, confirm }` (the uninstall preview and its hash), with the hash it uninstalls;
   * `all` and builtin plugins refuse (`plugin.scope_locked`). A required bootstrap plugin and an
   * extension declared in the startup config keep the direct write. `config` is always a direct write.
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
    const { confirm, ...input } = body;
    const itemId = body.enabled === undefined ? null : await this.configs.switchItemOf(extension);
    let write = input;
    if (itemId !== null) {
      const r = await this.catalog.setSwitch(
        org.orgId,
        p.account.id,
        itemId,
        body.enabled
          ? { enabled: true }
          : { enabled: false, ...(confirm !== undefined && { confirm }) },
        patTokenId(p),
      );
      if (r.kind === "preview") return { preview: r.preview, confirm: r.confirm };
      // The switch is done; what is left is the config (and, switching on, the enabled extension)
      write = { ...input, enabled: body.enabled ? true : undefined };
      if (!body.enabled && input.config === undefined) {
        const view = (await this.configs.list(org.orgId)).find((v) => v.plugin === extension);
        if (view)
          return { extension: { ...view, displayName: await this.displayNames.get(extension) } };
      }
    }
    // Switching on with nothing else to write: the install enabled it already (no second write)
    const opts =
      itemId !== null && body.enabled && input.config === undefined
        ? { ifDisabled: { skipped: false } }
        : {};
    const view = await this.configs.put(
      org.orgId,
      extension,
      write,
      p.account.id,
      patTokenId(p),
      opts,
    );
    return { extension: { ...view, displayName: await this.displayNames.get(view.plugin) } };
  }
}
