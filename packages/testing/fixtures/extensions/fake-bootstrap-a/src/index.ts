import {
  defineExtension,
  MODEL_PROVIDER_EXTENSION_POINT_V2,
  type ModelProvider,
  secret,
} from "@capybara-hq/plugin-sdk";
import { z } from "zod";

/**
 * Test fake for the bootstrap step: a model provider (`model-provider@2`) whose deployment config
 * has a required secret `apiKey`, so an unconfigured deployment leaves it pending configuration
 * (as the image's model provider is). Once configured it offers one model `fake-a-1` that answers
 * every request with `fake-bootstrap-a`; it never calls a network service.
 */

const DeploymentConfig = z.object({
  apiKey: secret(z.string().min(1)),
  baseUrl: z.string().url().optional(),
});

const REPLY = "fake-bootstrap-a";

const provider: ModelProvider = {
  async listModels() {
    return [
      {
        id: "fake-a-1",
        displayName: "Fake A 1",
        contextWindow: 8192,
        maxOutputTokens: 1024,
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
  async *stream() {
    yield { type: "text_delta", text: REPLY };
    yield {
      type: "message_complete",
      content: [{ type: "text", text: REPLY }],
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  },
};

export default defineExtension({
  name: "fake-bootstrap-a",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: [MODEL_PROVIDER_EXTENSION_POINT_V2],
  config: { deployment: DeploymentConfig },
  setup(ctx) {
    ctx.provide(MODEL_PROVIDER_EXTENSION_POINT_V2, provider);
  },
});
