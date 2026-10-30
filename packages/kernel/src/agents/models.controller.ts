import type { ModelInfo } from "@capybara-hq/plugin-sdk";
import { Controller, Get, Inject } from "@nestjs/common";
import { OrgAction } from "../orgs/org.guard.js";
import { ProviderRegistry } from "../runtime/providers.js";

/** 可选模型（`/api/v1/orgs/:orgId/models`）：已安装的模型供应商及其模型，列表缓存在 Redis。 */
@Controller("api/v1/orgs/:orgId/models")
export class ModelsController {
  constructor(@Inject(ProviderRegistry) private readonly registry: ProviderRegistry) {}

  @Get()
  @OrgAction("agents.use")
  async list(): Promise<{ providers: { provider: string; models: ModelInfo[] }[] }> {
    return { providers: await this.registry.list() };
  }
}
