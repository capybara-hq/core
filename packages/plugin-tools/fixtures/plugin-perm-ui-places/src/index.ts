import { defineExtension } from "@capybara-hq/plugin-sdk";

const render = async () => ({ blocks: [] });

// UI refresh B slots: a declared section and panel pass; an inline card view that is not in
// permissions.ui.views is reported like any other view.
export default defineExtension({
  name: "perm-ui-places",
  version: "0.0.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  ui: [
    { id: "panel", title: { zh: "面板", en: "Panel" }, slot: "conversation.panel", kind: "view", icon: "chart" },
    { id: "side", title: { zh: "侧栏", en: "Side" }, slot: "conversation.properties.section", kind: "view" },
    { id: "card", title: { zh: "卡片", en: "Card" }, slot: "conversation.tool-result.card", kind: "view" },
  ],
  permissions: { ui: { views: ["panel", "side"] } },
  setup(ctx) {
    ctx.ui.view("panel", render);
    ctx.ui.view("side", render);
    ctx.ui.view("card", render); // FLAG
  },
});
