import { defineExtension } from "@capybara-hq/plugin-sdk";

/**
 * Test fake: the requirer side of a dependency pair. Requires `counter@1` (provided by
 * `fake-dep-provider`, which its plugin.json also lists as a plugin dependency); the route
 * `GET /ping` answers with what the provider's `ping()` returns.
 */
export default defineExtension({
  name: "fake-dep-requirer",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  requires: ["counter@1"],
  permissions: { http: [{ method: "GET", path: "/ping" }] },
  setup(ctx) {
    ctx.http.route("GET", "/ping", async () => {
      const impl = ctx.extensionPoints.list<{ ping(): string }>("counter@1")[0]?.impl;
      return new Response(impl ? impl.ping() : "no provider", { status: impl ? 200 : 503 });
    });
  },
});
