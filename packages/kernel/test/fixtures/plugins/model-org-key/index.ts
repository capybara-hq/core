import {
  defineExtension,
  MODEL_PROVIDER_EXTENSION_POINT_V2,
  type ModelProvider,
  type ModelStreamEvent,
  orgAccess,
  secret,
} from "@capybara-hq/plugin-sdk";
import { z } from "zod";

/** The key is overridable and required: the platform may leave it empty for orgs to fill in. */
const Config = z.object({ apiKey: orgAccess(secret(z.string().min(1)), "override") });

/**
 * A model provider every org configures with its own key (model platform spec B §5.5): installed
 * without a platform key, following orgs need configuration and the admin view shows it as
 * configured by each org. Lists one chat model named after the key's length (no key in output).
 */
export default defineExtension({
  name: "model-org-key",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: [MODEL_PROVIDER_EXTENSION_POINT_V2],
  config: { deployment: Config },
  setup(ctx) {
    const provider: ModelProvider = {
      async listModels(opts) {
        const parsed = Config.safeParse(opts?.config ?? ctx.config);
        if (!parsed.success) throw new Error("model-org-key: no key");
        return [
          {
            id: `key-${parsed.data.apiKey.length}`,
            displayName: "Keyed",
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
          content: [{ type: "text", text: "keyed" }],
          stopReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
      },
    };
    ctx.provide(MODEL_PROVIDER_EXTENSION_POINT_V2, provider);
  },
});
