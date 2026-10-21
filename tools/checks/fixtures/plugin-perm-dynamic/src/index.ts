import { definePlugin } from "@capybara-hq/plugin-sdk";

declare const paths: string[];
declare const names: string[];
declare const refs: string[];

export default definePlugin({
  name: "perm-dynamic",
  version: "0.0.0",
  sdk: "^0.1.0",
  provides: [],
  setup(ctx) {
    for (const p of paths) ctx.http.route("GET", p, async () => Response.json({})); // FLAG
    ctx.tools.register({ name: names[0] as string, description: "x" }, async () => ({ content: "" })); // FLAG
    ctx.capabilities.get(refs[0] as string); // FLAG
    // capybara:allow-dynamic-permission the path list is fixed by the deployment
    for (const p of paths) ctx.http.route("GET", p, async () => Response.json({}));
    ctx.capabilities.get(refs[1] as string); // capybara:allow-dynamic-permission refs come from a vetted list
    ctx.capabilities.get(refs[2] as string); // capybara:allow-dynamic-permission
  },
});
