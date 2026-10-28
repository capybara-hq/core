import { defineExtension } from "@capybara-hq/plugin-sdk";

const render = async () => ({ blocks: [] });

// UI refresh B places: a declared section and panel pass; an inline card view that is not in
// permissions.ui.views is reported like any other view.
export default defineExtension({
  name: "perm-ui-places",
  version: "0.0.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  ui: [
    { id: "panel", title: { zh: "面板", en: "Panel" }, place: "panel", kind: "view", icon: "chart" },
    { id: "side", title: { zh: "侧栏", en: "Side" }, place: "section", kind: "view" },
    { id: "card", title: { zh: "卡片", en: "Card" }, place: "inline", kind: "view" },
  ],
  permissions: { ui: { views: ["panel", "side"] } },
  setup(ctx) {
    ctx.ui.view("panel", render);
    ctx.ui.view("side", render);
    ctx.ui.view("card", render); // FLAG
  },
});
