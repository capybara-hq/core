import {
  definePlugin,
  MODEL_PROVIDER_CAPABILITY,
  type ModelInfoV1,
  type ModelProviderV1,
} from "@capybara-hq/plugin-sdk";

const info = (id: string): ModelInfoV1 => ({
  id,
  displayName: id,
  contextWindow: 8_000,
  maxOutputTokens: 1_000,
  capabilities: {
    tools: false,
    vision: false,
    reasoning: false,
    caching: false,
    midConversationSystem: false,
    effort: false,
  },
});

/** 第二个模型供应商（测试用）：两个静态模型；`listModelsCalls` 统计 listModels 被调用的次数。 */
export interface FakeBProvider extends ModelProviderV1 {
  listModelsCalls: number;
}

export default definePlugin({
  name: "model-fake-b",
  version: "0.1.0",
  sdk: "^0.1.0",
  provides: [MODEL_PROVIDER_CAPABILITY],
  setup(ctx) {
    const provider: FakeBProvider = {
      listModelsCalls: 0,
      async listModels() {
        provider.listModelsCalls++;
        return [info("b-1"), info("b-2")];
      },
      stream() {
        throw new Error("model-fake-b does not stream");
      },
    };
    ctx.provide(MODEL_PROVIDER_CAPABILITY, provider);
  },
});
