import { defineExtension } from "@capybara-hq/plugin-sdk";

/**
 * Test fake: the provider side of a dependency pair. Provides `counter@1` (an object with
 * `ping()` returning `pong from fake-dep-provider`) and the route `GET /ping` with the same text.
 * `fake-dep-requirer` requires the point and lists this plugin as a plugin dependency.
 */
export default defineExtension({
  name: "fake-dep-provider",
  version: "0.1.0",
  sdk: "^0.1.0",
  provides: ["counter@1"],
  permissions: { http: [{ method: "GET", path: "/ping" }] },
  setup(ctx) {
    const pong = "pong from fake-dep-provider";
    ctx.provide("counter@1", { ping: () => pong });
    ctx.http.route("GET", "/ping", async () => new Response(pong));
  },
});
