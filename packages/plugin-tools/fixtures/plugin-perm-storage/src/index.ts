import { defineExtension } from "@capybara-hq/plugin-sdk";

export const undeclared = defineExtension({
  name: "perm-storage",
  version: "0.0.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  setup(ctx) {
    void ctx.storage.head("org", "a.txt"); // FLAG
    const c = ctx;
    void c.storage.list("org", ""); // FLAG
  },
});

export const declaredFalse = defineExtension({
  name: "perm-storage-false",
  version: "0.0.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  permissions: { storage: false },
  setup(ctx) {
    void ctx.storage.delete("org", "a.txt"); // FLAG
  },
});
