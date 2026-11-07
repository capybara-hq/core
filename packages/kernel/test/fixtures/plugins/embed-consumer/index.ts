import { defineExtension } from "@capybara-hq/plugin-sdk";

/**
 * Declares one embedding purpose (`embed-consumer.index`, `permissions.models`) and nothing else:
 * purpose targets must be of the purpose's kind (model platform spec B §5.3).
 */
export default defineExtension({
  name: "embed-consumer",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  permissions: {
    models: [
      {
        purpose: "embed-consumer.index",
        kind: "embedding",
        label: { zh: "索引", en: "Index" },
      },
    ],
  },
  setup() {},
});
