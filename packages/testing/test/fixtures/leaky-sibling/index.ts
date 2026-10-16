import { definePlugin } from "@capybara-hq/plugin-sdk";
import { counts } from "./store.js";

export default definePlugin({
  name: "leaky-sibling",
  version: "0.1.0",
  sdk: "^0.1.0",
  provides: [],
  setup(ctx) {
    ctx.http.route("POST", "/inc", async () => {
      const next = (counts.get("n") ?? 0) + 1;
      counts.set("n", next);
      return Response.json({ count: next });
    });
    ctx.http.route("GET", "/count", async () => Response.json({ count: counts.get("n") ?? 0 }));
  },
});
