import { definePlugin } from "@capybara-hq/plugin-sdk";

export const undeclared = definePlugin({
  name: "perm-storage",
  version: "0.0.0",
  sdk: "^0.1.0",
  provides: [],
  setup(ctx) {
    void ctx.storage.head("org", "a.txt"); // FLAG
    const c = ctx;
    void c.storage.list("org", ""); // FLAG
  },
});

export const declaredFalse = definePlugin({
  name: "perm-storage-false",
  version: "0.0.0",
  sdk: "^0.1.0",
  provides: [],
  permissions: { storage: false },
  setup(ctx) {
    void ctx.storage.delete("org", "a.txt"); // FLAG
  },
});
