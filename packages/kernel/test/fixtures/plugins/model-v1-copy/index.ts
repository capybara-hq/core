import {
  defineExtension,
  MODEL_PROVIDER_EXTENSION_POINT,
  type ModelProviderV1,
  type ModelStreamEvent,
  orgAccess,
} from "@capybara-hq/plugin-sdk";
import { z } from "zod";

/** One overridable field: an org may keep its own copy of it. */
const Config = z.object({ label: orgAccess(z.string().optional(), "override") });

/**
 * A `model-provider@1` with an overridable config field (model platform spec B §5.5): an `@1`
 * provider ignores the per-call options and reads `ctx.config`, so an org's own copy cannot be
 * honoured and the kernel treats the provider as needing configuration in that org. Lists `v1-a`.
 */
export default defineExtension({
  name: "model-v1-copy",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: [MODEL_PROVIDER_EXTENSION_POINT],
  config: { deployment: Config },
  setup(ctx) {
    const provider: ModelProviderV1 = {
      async listModels() {
        return [
          {
            id: "v1-a",
            displayName: "V1 A",
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
          },
        ];
      },
      async *stream(): AsyncIterable<ModelStreamEvent> {
        yield {
          type: "message_complete",
          content: [{ type: "text", text: "v1" }],
          stopReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
      },
    };
    ctx.provide(MODEL_PROVIDER_EXTENSION_POINT, provider);
  },
});
