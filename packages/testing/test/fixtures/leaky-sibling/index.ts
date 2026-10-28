import { defineExtension } from "@capybara-hq/plugin-sdk";
import { counts } from "./store.js";

export default defineExtension({
  name: "leaky-sibling",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  permissions: {
    http: [
      { method: "POST", path: "/inc" },
      { method: "GET", path: "/count" },
    ],
  },
  setup(ctx) {
    ctx.http.route("POST", "/inc", async () => {
      const next = (counts.get("n") ?? 0) + 1;
      counts.set("n", next);
      return Response.json({ count: next });
    });
    ctx.http.route("GET", "/count", async () => Response.json({ count: counts.get("n") ?? 0 }));
  },
});
