import {
  defineExtension,
  MODEL_PROVIDER_EXTENSION_POINT_V2,
  type ModelInfo,
  type ModelProvider,
  type ModelRequest,
} from "@capybara-hq/plugin-sdk";

/** 测试用模型供应商（M5 T3 附件）：`see-1` 支持图片与文档，`blind-1` 都不支持。 */
const info = (id: string, media: boolean): ModelInfo => ({
  id,
  displayName: id,
  contextWindow: 200_000,
  maxOutputTokens: 1_000,
  capabilities: {
    tools: false,
    vision: media,
    reasoning: false,
    caching: false,
    midConversationSystem: true,
    documents: media,
  },
  parameters: [],
});

/** 记录收到的每个请求（深拷贝），测试经 `host.list("model-provider")` 取 impl 读取。 */
export interface MediaProvider extends ModelProvider {
  requests: ModelRequest[];
}

export default defineExtension({
  name: "model-media",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: [MODEL_PROVIDER_EXTENSION_POINT_V2],
  setup(ctx) {
    const provider: MediaProvider = {
      requests: [],
      async listModels() {
        return [info("see-1", true), info("blind-1", false)];
      },
      async *stream(req) {
        provider.requests.push(structuredClone(req));
        yield {
          type: "message_complete",
          content: [{ type: "text", text: "ok" }],
          stopReason: "end_turn",
          usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
      },
    };
    ctx.provide(MODEL_PROVIDER_EXTENSION_POINT_V2, provider);
  },
});
