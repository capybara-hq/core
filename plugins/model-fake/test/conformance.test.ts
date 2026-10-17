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
    provider: createFakeProvider({ kv }),
    model: "fake-1",
    expect: { thinking: false, caching: true },
    teardown: async () => {},
  };
});
