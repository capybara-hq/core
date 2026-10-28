import { defineExtension } from "@capybara-hq/plugin-sdk";

/** 测试观察点：`GET /hold` 收到 `req.signal` 中止的次数（同进程测试读它）。 */
export const SSE_HOLD_KEY = "__sseHoldAborted";

/** 停机测试用插件：`GET /hold` 是一条 SSE，先发一帧，之后只在 `req.signal` 中止时结束。 */
export default defineExtension({
  name: "sse-hold",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  permissions: { http: [{ method: "GET", path: "/hold" }] },
  setup(ctx) {
    ctx.http.route("GET", "/hold", async (req) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(": open\n\n"));
          req.signal.addEventListener("abort", () => {
            const g = globalThis as unknown as Record<string, number | undefined>;
            g[SSE_HOLD_KEY] = (g[SSE_HOLD_KEY] ?? 0) + 1;
            controller.close();
          });
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    });
  },
});
