import type { LocalizedName, ModelInfo } from "@capybara-hq/plugin-sdk";
import { Controller, Get, Inject } from "@nestjs/common";
import { ExtensionDisplayNames } from "../extensions/display-name.js";
import { OrgAction } from "../orgs/org.guard.js";
import { ProviderRegistry } from "../runtime/providers.js";

/**
 * 可选模型（`/api/v1/orgs/:orgId/models`）：已安装的模型供应商及其模型，列表缓存在 Redis。Each provider
 * carries its extension's display name (null when it has none).
 */
@Controller("api/v1/orgs/:orgId/models")
export class ModelsController {
  constructor(
    @Inject(ProviderRegistry) private readonly registry: ProviderRegistry,
    @Inject(ExtensionDisplayNames) private readonly displayNames: ExtensionDisplayNames,
  ) {}

  @Get()
  @OrgAction("agents.use")
  async list(): Promise<{
    providers: { provider: string; displayName: LocalizedName | null; models: ModelInfo[] }[];
  }> {
    const providers = await this.registry.list();
    const names = await this.displayNames.many(providers.map((p) => p.provider));
    return {
      providers: providers.map((p) => ({
        provider: p.provider,
        displayName: names.get(p.provider) ?? null,
        models: p.models,
      })),
    };
  }
}
