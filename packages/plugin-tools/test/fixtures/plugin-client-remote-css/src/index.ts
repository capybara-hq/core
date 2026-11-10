// Fixture: an extension with one client component (`hud`).
export default {
  name: "fixture-plugin-client-remote-css",
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
};
