import { defineExtension } from "@capybara-hq/plugin-sdk";

export default defineExtension({
  name: "perm-reserved",
  version: "0.0.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  permissions: { storage: true },
  setup(ctx) {
    // 已声明 permissions.storage：ctx.storage 不再是预留项，不报
    void ctx.storage.head("org", "a.txt");
    void ctx.models; // FLAG
  },
});
