import { describeModelProviderConformance } from "@capybara-hq/testing";
import { createFakeProvider, type Kv } from "../src/script.js";

describeModelProviderConformance("model-fake", async () => {
  const store = new Map<string, string>();
  const kv: Kv = {
    get: async (k) => store.get(k) ?? null,
    set: async (k, v) => {
      store.set(k, v);
    },
  };
  return {
    plugin: "model-fake",
    provider: createFakeProvider({
      kv,
      models: [
        { id: "fake-1" },
        { id: "emb-1", kind: "embedding" },
        { id: "img-1", kind: "image_generation" },
      ],
    }),
    model: "fake-1",
    expect: {
      thinking: false,
      caching: true,
      embedding: { model: "emb-1", dimensions: 8 },
      imageGeneration: { model: "img-1" },
    },
    teardown: async () => {},
  };
});
