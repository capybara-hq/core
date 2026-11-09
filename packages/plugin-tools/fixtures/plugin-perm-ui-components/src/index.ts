import { defineExtension } from "@capybara-hq/plugin-sdk";

const render = async () => ({ blocks: [], data: { n: 1 } });

// Client extensions spec §5.2: a component may have a server view and action under its own id
// (listed in permissions.ui.components); an id in no list is reported.
export default defineExtension({
  name: "perm-ui-components",
  version: "0.0.0",
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
  setup(ctx) {
    ctx.ui.view("hud", render);
    ctx.ui.action("hud", async () => ({}));
    ctx.ui.view("ghost", render); // FLAG
  },
});
