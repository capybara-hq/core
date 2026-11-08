import {
  defineExtension,
  MODEL_PROVIDER_EXTENSION_POINT_V2,
  type ModelProvider,
  type ModelStreamEvent,
  orgAccess,
} from "@capybara-hq/plugin-sdk";
import { z } from "zod";

/** `fail` is overridable: an org's copy with `fail: true` makes that org's list fail. */
const Config = z.object({ fail: orgAccess(z.boolean().optional(), "override") });

/**
 * A model provider whose `listModels` fails when the config it is called with says `fail` (model
 * platform spec B §5.5): an org's copy failing must not mark the platform's list as failed. Lists
 * `cf-1`.
 */
export default defineExtension({
  name: "model-copy-fail",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: [MODEL_PROVIDER_EXTENSION_POINT_V2],
  config: { deployment: Config },
  setup(ctx) {
    const provider: ModelProvider = {
      async listModels(opts) {
        const parsed = Config.safeParse(opts?.config ?? ctx.config);
        if (parsed.success && parsed.data.fail === true) throw new Error("copy list fails");
        return [
          {
            id: "cf-1",
            displayName: "CF 1",
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
          },
        ];
      },
      async *stream(): AsyncIterable<ModelStreamEvent> {
        yield {
          type: "message_complete",
          content: [{ type: "text", text: "cf" }],
          stopReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
      },
    };
    ctx.provide(MODEL_PROVIDER_EXTENSION_POINT_V2, provider);
  },
});
