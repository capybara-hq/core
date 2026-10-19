import { definePlugin, type PluginContext } from "@capybara-hq/plugin-sdk";

function mount(c: PluginContext): void {
  c.http.route("DELETE", "/helper", async () => Response.json({})); // FLAG
}

export default definePlugin({
  name: "perm-http",
  version: "0.0.0",
  sdk: "^0.1.0",
  provides: [],
  permissions: { http: [{ method: "GET", path: "/ok" }] },
  setup(ctx) {
    ctx.http.route("GET", "/ok", async () => Response.json({}));
    ctx.http.route("POST", "/ok", async () => Response.json({})); // FLAG
    ctx.http.route("GET", "/other", async () => Response.json({})); // FLAG
    mount(ctx);
  },
});
