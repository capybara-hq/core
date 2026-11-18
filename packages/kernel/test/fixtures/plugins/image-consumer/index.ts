import { defineExtension, type ExtensionContext } from "@capybara-hq/plugin-sdk";

/** The running instance's ctx, shared with the test (same process; set by `setup`). */
export function imageConsumer(): { ctx: ExtensionContext | undefined } {
  const g = globalThis as { __imageConsumer?: { ctx: ExtensionContext | undefined } };
  g.__imageConsumer ??= { ctx: undefined };
  return g.__imageConsumer;
}

/**
 * Declares one image generation purpose (`image-consumer.art`) and one embedding purpose
 * (`image-consumer.memory`) in `permissions.models`: `ctx.models.generateImage` accepts only the
 * first, `ctx.models.describe` dispatches on the declared kind (image generation spec §5.5).
 */
export default defineExtension({
  name: "image-consumer",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  permissions: {
    models: [
      {
        purpose: "image-consumer.art",
        kind: "image_generation",
        label: { zh: "插图", en: "Illustrations" },
      },
      {
        purpose: "image-consumer.memory",
        kind: "embedding",
        label: { zh: "记忆", en: "Memory" },
      },
    ],
  },
  setup(ctx) {
    imageConsumer().ctx = ctx;
  },
});
