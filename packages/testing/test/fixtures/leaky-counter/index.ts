import { definePlugin } from "@capybara-hq/plugin-sdk";

// 故意的反例：计数放进程内存，多副本下各实例各数各的。
const counts = new Map<string, number>(); // capybara:allow-module-state 故意的反例，用于证明双副本工具能发现进程内状态

export default definePlugin({
  name: "leaky-counter",
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
