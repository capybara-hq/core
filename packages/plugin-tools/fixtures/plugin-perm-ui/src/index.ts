import { defineExtension } from "@capybara-hq/plugin-sdk";

declare const ids: string[];

const TASKS = "tasks";
const render = async () => ({ blocks: [] });

export default defineExtension({
  name: "perm-ui",
  version: "0.0.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  ui: [
    { id: "tasks", title: { zh: "任务", en: "Tasks" }, place: "conversation", kind: "view" },
    { id: "board", title: { zh: "看板", en: "Board" }, place: "page", kind: "embed", path: "/ui/b" },
  ],
  permissions: {
    http: [{ method: "GET", path: "/ui/b" }],
    ui: { views: [TASKS], embeds: ["board"] },
  },
  setup(ctx) {
    ctx.ui.view(TASKS, render);
    ctx.ui.action("tasks", async () => ({}));
    void ctx.ui.invalidate({ orgId: "o", contribution: "tasks" });
    void ctx.ui.verifyEmbedToken("t");
    ctx.ui.view("sneaky", render); // FLAG
    ctx.ui.action("board", async () => ({})); // FLAG
    ctx.ui.view(ids[0] as string, render); // FLAG
    // capybara:allow-dynamic-permission ids are the declared views, fixed at build time
    ctx.ui.view(ids[1] as string, render);
    // capybara:allow-dynamic-permission not exemptible: an explicit violation
    ctx.ui.view("other", render); // FLAG
    const u = ctx.ui; // FLAG
    void u;
  },
});
