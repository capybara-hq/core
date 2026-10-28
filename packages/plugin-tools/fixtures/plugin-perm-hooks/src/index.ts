import { defineExtension } from "@capybara-hq/plugin-sdk";

declare const mounts: "model.request"[];

const RESPONSE = "model.response";

export default defineExtension({
  name: "perm-hooks",
  version: "0.0.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  permissions: {
    hooks: ["model.request", RESPONSE, "tool.preExecute"],
    policyHooks: ["model.request"],
  },
  setup(ctx) {
    ctx.hooks.on("model.request", () => undefined, { mode: "policy" });
    ctx.hooks.on(RESPONSE, () => {}, { mode: "observe" });
    ctx.hooks.on("tool.preExecute", () => undefined, { mode: "policy" }); // FLAG
    ctx.hooks.on("tool.preExecute", () => undefined, { mode: "observe" });
    ctx.hooks.on(mounts[0] as "model.request", () => {}, { mode: "observe" }); // FLAG
    // capybara:allow-dynamic-permission mounts are the declared hooks, fixed at build time
    ctx.hooks.on(mounts[1] as "model.request", () => {}, { mode: "observe" });
    // capybara:allow-dynamic-permission not exemptible: an explicit violation
    ctx.hooks.on("tool.postExecute", () => {}, { mode: "observe" }); // FLAG
    const h = ctx.hooks; // FLAG
    void h;
  },
});
