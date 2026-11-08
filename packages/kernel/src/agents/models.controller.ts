import type { LocalizedName } from "@capybara-hq/plugin-sdk";
import { Controller, Get, Inject } from "@nestjs/common";
import { z } from "zod";
import { ExtensionDisplayNames } from "../extensions/display-name.js";
import { orgIconScope, PluginIcons } from "../extensions/plugin-icons.js";
import { CurrentPrincipal, type Principal, requireUser } from "../identity/principal.js";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import { ZQuery } from "../infra/validation/zod-params.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import {
  type KernelModelInfo,
  ProviderRegistry,
  type ProviderStatus,
} from "../runtime/providers.js";

export const ModelsQuery = z.object({
  kind: z
    .enum([
      "chat",
      "embedding",
      "rerank",
      "image_generation",
      "video_generation",
      "speech_to_text",
      "text_to_speech",
      "other",
    ])
    .optional(),
});
class ModelsQueryDto extends createZodDto(ModelsQuery, "ModelsQuery") {}

/**
 * 可选模型（`/api/v1/orgs/:orgId/models`）：已安装的模型供应商及其模型，列表缓存在 Redis。Each provider
 * carries its extension's display name (null when it has none). Listed for the org (its effective
 * provider config: a provider needing configuration there is absent); only enabled models (neither
 * the platform nor the org disabled them, spec B §5.3), optionally of one `?kind=`; every model
 * carries its normalised `kind` (`other` for a kind this kernel does not know).
 */
@Controller("api/v1/orgs/:orgId/models")
export class ModelsController {
  constructor(
    @Inject(ProviderRegistry) private readonly registry: ProviderRegistry,
    @Inject(ExtensionDisplayNames) private readonly displayNames: ExtensionDisplayNames,
    @Inject(PluginIcons) private readonly icons: PluginIcons,
  ) {}

  @Get()
  @OrgAction("agents.use")
  async list(
    @CurrentOrg() org: OrgContext,
    @ZQuery(ModelsQueryDto) q: z.infer<typeof ModelsQuery>,
  ): Promise<{
    providers: {
      provider: string;
      displayName: LocalizedName | null;
      icon: string | null;
      models: KernelModelInfo[];
    }[];
  }> {
    const providers = await this.registry.list(
      org.orgId,
      q.kind === undefined ? {} : { kind: q.kind },
    );
    const plugins = providers.map((p) => p.provider);
    const [names, icons] = await Promise.all([
      this.displayNames.many(plugins),
      this.icons.many(plugins, orgIconScope(org)),
    ]);
    return {
      providers: providers.map((p) => ({
        provider: p.provider,
        displayName: names.get(p.provider) ?? null,
        icon: icons.get(p.provider) ?? null,
        models: p.models,
      })),
    };
  }

  /**
   * The org's model catalog (the settings page; `org.models.manage`, people only): every provider
   * with its status for the org and every model the platform left on, each with `disabled` for the
   * org's own list.
   */
  @Get("catalog")
  @OrgAction("org.models.manage")
  async catalog(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
  ): Promise<{
    providers: (ProviderStatus & { displayName: LocalizedName | null; icon: string | null })[];
  }> {
    requireUser(principal);
    const providers = await this.registry.catalog(org.orgId);
    const plugins = providers.map((p) => p.plugin);
    const [names, icons] = await Promise.all([
      this.displayNames.many(plugins),
      this.icons.many(plugins, orgIconScope(org)),
    ]);
    return {
      providers: providers.map((p) => ({
        ...p,
        displayName: names.get(p.plugin) ?? null,
        icon: icons.get(p.plugin) ?? null,
      })),
    };
  }
}
