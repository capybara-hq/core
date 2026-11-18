import {
  defineExtension,
  MODEL_PROVIDER_EXTENSION_POINT_V2,
  type ModelProvider,
} from "@capybara-hq/plugin-sdk";

/** A model provider with one `image_generation` model (`img-1`), for the image purpose tests. */
export default defineExtension({
  name: "model-image",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: [MODEL_PROVIDER_EXTENSION_POINT_V2],
  setup(ctx) {
    const provider: ModelProvider = {
      async listModels() {
        return [
          {
            id: "img-1",
            displayName: "img-1",
            contextWindow: 1_000,
            maxOutputTokens: 1_000,
            capabilities: {
              tools: false,
              vision: false,
              reasoning: false,
              caching: false,
              midConversationSystem: false,
            },
            parameters: [],
            kind: "image_generation",
            imageGeneration: {
              sizes: [{ width: 1024, height: 1024 }],
              defaultSize: { width: 1024, height: 1024 },
              maxImages: 2,
              maxReferenceImages: 0,
              outputMediaTypes: ["image/png"],
            },
          },
        ];
      },
      stream() {
        throw new Error("image model: not a chat model");
      },
      async generateImage(req) {
        return {
          images: Array.from({ length: req.n }, () => ({
            mediaType: "image/png" as const,
            data: "AAAA",
          })),
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
      },
    };
    ctx.provide(MODEL_PROVIDER_EXTENSION_POINT_V2, provider);
  },
});
