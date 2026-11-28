import { defineExtension } from "@capybara-hq/plugin-sdk";

const answer = async () => ({ items: [] });

// Plugin full pages spec §4.1: ctx.ui.query takes only an id in permissions.ui.components; a view
// id or an id in no list is reported.
export default defineExtension({
  name: "perm-ui-query",
  version: "0.0.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  ui: [
    { id: "board", title: { zh: "看板", en: "Board" }, slot: "org.page", kind: "component" },
    { id: "summary", title: { zh: "概要", en: "Summary" }, slot: "org.page", kind: "view" },
  ],
  permissions: { client: true, ui: { components: ["board"], views: ["summary"] } },
  setup(ctx) {
    ctx.ui.query("board", answer);
    ctx.ui.query("summary", answer); // FLAG
    ctx.ui.query("ghost", answer); // FLAG
  },
});
