import {
  definePlugin,
  MODEL_PROVIDER_CAPABILITY_V2,
  type ModelInfo,
  type ModelProvider,
} from "@capybara-hq/plugin-sdk";

/**
 * b-1 / b-2 声明的参数：五档 effort（默认 high，与 model-fake 的档位集合不同）和一个厂商专有参数。
 * 用于「主模型与兜底各按自己的声明校验」的测试。
 */
const info = (id: string): ModelInfo => ({
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
  },
  parameters: [
    {
      key: "effort",
      standard: "effort",
      schema: { type: "string", enum: ["low", "medium", "high", "xhigh", "max"] },
      default: "high",
      label: { zh: "思考深度", en: "Effort" },
    },
    {
      key: "model-fake-b.mode",
      schema: { type: "string", enum: ["plain", "fancy"] },
      default: "plain",
      label: { zh: "模式", en: "Mode" },
    },
  ],
});

/** 第二个模型供应商（测试用，model-provider@2）：两个静态模型；`listModelsCalls` 统计 listModels 被调用的次数。 */
export interface FakeBProvider extends ModelProvider {
  listModelsCalls: number;
}

export default definePlugin({
  name: "model-fake-b",
  version: "0.1.0",
  sdk: "^0.1.0",
  provides: [MODEL_PROVIDER_CAPABILITY_V2],
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
    ctx.provide(MODEL_PROVIDER_CAPABILITY_V2, provider);
  },
});
