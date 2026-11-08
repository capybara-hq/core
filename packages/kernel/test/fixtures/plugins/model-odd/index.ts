import {
  defineExtension,
  MODEL_PROVIDER_EXTENSION_POINT_V2,
  type ModelInfo,
  type ModelKind,
  type ModelStreamEvent,
} from "@capybara-hq/plugin-sdk";

const info = (id: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({
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
  parameters: [],
  ...extra,
});

/**
 * A model provider whose list holds one valid chat model and three odd entries (model platform
 * spec B §5.1): a chat model with an invalid parameter declaration (a non-standard key without the
 * plugin prefix), an `embedding` model without `embedding` info, and a model of a kind this kernel
 * does not know (`hologram`, a newer plugin). It implements no `embed`.
 */
export default defineExtension({
  name: "model-odd",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: [MODEL_PROVIDER_EXTENSION_POINT_V2],
  setup(ctx) {
    ctx.provide(MODEL_PROVIDER_EXTENSION_POINT_V2, {
      async listModels() {
        return [
          info("odd-chat"),
          info("odd-bad-params", {
            parameters: [
              { key: "style", schema: { type: "boolean" }, label: { zh: "风格", en: "Style" } },
            ],
          }),
          info("odd-embed", { kind: "embedding" }),
          info("odd-hologram", { kind: "hologram" as ModelKind }),
        ];
      },
      async *stream(): AsyncIterable<ModelStreamEvent> {
        yield {
          type: "message_complete",
          content: [{ type: "text", text: "odd" }],
          stopReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
      },
    });
  },
});
