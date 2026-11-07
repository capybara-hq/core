import { defineExtension } from "@capybara-hq/plugin-sdk";

export default defineExtension({
  name: "perm-models",
  version: "0.0.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  permissions: { storage: true },
  setup(ctx) {
    void ctx.storage.head("org", "a.txt");
    void ctx.models.embed({ orgId: "org", purpose: "perm-models.memory", input: ["x"] }); // FLAG
  },
});

export const empty = defineExtension({
  name: "perm-models-empty",
  version: "0.0.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  permissions: { models: [] },
  setup(ctx) {
    void ctx.models.describe({ orgId: "org", purpose: "perm-models-empty.memory" }); // FLAG
  },
});

export const declared = defineExtension({
  name: "perm-models-declared",
  version: "0.0.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  permissions: {
    models: [
      { purpose: "perm-models-declared.memory", kind: "embedding", label: { zh: "记忆", en: "Memory" } },
    ],
  },
  setup(ctx) {
    // permissions.models declared: ctx.models is not reported
    void ctx.models.describe({ orgId: "org", purpose: "perm-models-declared.memory" });
  },
});
