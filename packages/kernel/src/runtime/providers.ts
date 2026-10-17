import type { ModelInfo, ModelProvider } from "@capybara-hq/plugin-sdk";
import type { Redis } from "ioredis";
import type { ModelRef } from "../agents/definition.js";
import { ApiError } from "../errors.js";
import type { PluginHost } from "../plugins/host.js";

/** 供应商模型列表在 Redis 中的缓存时长（秒）。 */
const MODELS_TTL_SECONDS = 600;
const modelsKey = (provider: string) => `capk:models:${provider}`;

/**
 * 模型供应商注册表：供应商即提供 `model-provider` 能力的插件（以插件名为供应商名）。
 * 每个供应商的 `listModels()` 结果缓存在 Redis `capk:models:<provider>`（EX 600），不放进程内存，
 * 多副本共享同一份缓存。
 */
export class ProviderRegistry {
  constructor(
    private readonly host: Pick<PluginHost, "list">,
    private readonly kv: Redis,
  ) {}

  private providers(): { plugin: string; impl: ModelProvider }[] {
    return this.host
      .list("model-provider")
      .map((p) => ({ plugin: p.plugin, impl: p.impl as ModelProvider }));
  }

  private async models(provider: string, impl: ModelProvider): Promise<ModelInfo[]> {
    const key = modelsKey(provider);
    const cached = await this.kv.get(key);
    if (cached !== null) return JSON.parse(cached) as ModelInfo[];
    const models = await impl.listModels();
    await this.kv.set(key, JSON.stringify(models), "EX", MODELS_TTL_SECONDS);
    return models;
  }

  /** 每个已安装供应商及其模型（按插件加载顺序）。 */
  async list(): Promise<{ provider: string; models: ModelInfo[] }[]> {
    return Promise.all(
      this.providers().map(async (p) => ({
        provider: p.plugin,
        models: await this.models(p.plugin, p.impl),
      })),
    );
  }

  /** 解析模型引用；供应商未安装或模型不存在 → `agent.model_unavailable`。 */
  async resolve(ref: ModelRef): Promise<{ provider: ModelProvider; info: ModelInfo }> {
    const p = this.providers().find((x) => x.plugin === ref.provider);
    const info = p && (await this.models(p.plugin, p.impl)).find((m) => m.id === ref.model);
    if (!p || !info) {
      throw new ApiError(
        "agent.model_unavailable",
        `Model ${ref.provider}/${ref.model} is not available`,
      );
    }
    return { provider: p.impl, info };
  }
}
