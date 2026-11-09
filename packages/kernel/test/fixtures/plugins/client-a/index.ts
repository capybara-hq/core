import { defineExtension } from "@capybara-hq/plugin-sdk";

/** Client permission review: an extension with client code and one component (`hud`). */
export default defineExtension({
  name: "client-a",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  ui: [
    {
      id: "hud",
      title: { zh: "状态", en: "Status" },
      slot: "conversation.properties.section",
      kind: "component",
    },
  ],
  permissions: { client: true, ui: { components: ["hud"] } },
  setup() {},
});
