import { definePlugin } from "@capybara-hq/plugin-sdk";

/** 返回当前进程 pid，用来证明请求确实交替落在不同进程。 */
export default definePlugin({
  name: "whoami",
  version: "0.1.0",
  sdk: "^0.1.0",
  provides: [],
  setup(ctx) {
    ctx.http.route("GET", "/pid", async () => Response.json({ pid: process.pid }));
  },
});
