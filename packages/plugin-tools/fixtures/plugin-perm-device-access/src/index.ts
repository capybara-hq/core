import { defineExtension } from "@capybara-hq/plugin-sdk";

export const undeclared = defineExtension({
  name: "perm-device-access",
  version: "0.0.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  setup(ctx) {
    void ctx.deviceAccess.addNetworkHosts({ conversationId: "c", accountId: "a", hosts: [] }); // FLAG
  },
});

export const declared = defineExtension({
  name: "perm-device-access-ok",
  version: "0.0.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  permissions: { deviceAccess: { services: ["browser"] } },
  setup(ctx) {
    void ctx.deviceAccess.addNetworkHosts({ conversationId: "c", accountId: "a", hosts: [] });
  },
});
