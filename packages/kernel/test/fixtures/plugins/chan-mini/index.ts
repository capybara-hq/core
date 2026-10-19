import { type Channel, definePlugin, type InboundEvent, secret } from "@capybara-hq/plugin-sdk";
import { z } from "zod";

/**
 * 测试用最小 `channel@1`（Task 13 另有完整的假渠道插件）：连接测试里起的假 IM 平台（test/helpers/fake-im.ts）。
 * - verify：`appSecret === "bad-secret"` 时失败；租户为 `tenant`（默认 t1）。
 * - connect：`GET <platformUrl>/connect` 拿一条 NDJSON 长连接，逐行交给 `onEvent`；平台关闭连接后自行重连，
 *   连接请求失败（非 200）时抛错（内核据此记录 last_error 并退避重试）。请求头 `x-pid` 告诉平台是哪个进程连上的。
 * - send / update：POST 给平台，平台记下来供断言。
 */
const Conn = z.object({
  platformUrl: z.string().url(),
  appId: z.string().min(1),
  tenant: z.string().min(1).default("t1"),
  appSecret: secret(z.string().min(1)),
});
type ConnConfig = z.infer<typeof Conn>;

const channel: Channel = {
  connectionSchema: Conn,
  features: { cards: true, edit: true, threads: true },
  async verify({ config }) {
    const c = config as ConnConfig;
    if (c.appSecret === "bad-secret") throw new Error("invalid app secret");
    return { botUserId: `bot-${c.appId}`, botName: "Mini", tenantId: c.tenant };
  },
  async connect({ connectionId, config, onEvent, signal }) {
    const c = config as ConnConfig;
    while (!signal.aborted) {
      try {
        const res = await fetch(
          `${c.platformUrl}/connect?connection=${encodeURIComponent(connectionId)}`,
          { signal, headers: { "x-pid": String(process.pid), "x-app-id": c.appId } },
        );
        if (res.status !== 200 || !res.body) {
          await res.body?.cancel();
          throw new Error(`connect failed with status ${res.status}`);
        }
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl = buf.indexOf("\n");
          while (nl >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (line !== "") {
              try {
                await onEvent(JSON.parse(line) as InboundEvent);
              } catch {
                // 处理失败：真实平台会因未确认而重投；测试里由平台手动重推
              }
            }
            nl = buf.indexOf("\n");
          }
        }
      } catch (e) {
        if (signal.aborted) return;
        throw e;
      }
      // 平台关闭了连接：稍后重连
      await new Promise((r) => setTimeout(r, 50));
    }
  },
  async send({ config, target, message }) {
    const c = config as ConnConfig;
    const res = await fetch(`${c.platformUrl}/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appId: c.appId, target, message }),
    });
    return (await res.json()) as { messageId: string };
  },
  async update({ config, target, message, messageId }) {
    const c = config as ConnConfig;
    await fetch(`${c.platformUrl}/update`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appId: c.appId, target, message, messageId }),
    });
  },
};

export default definePlugin({
  name: "chan-mini",
  version: "0.1.0",
  sdk: "^0.1.0",
  provides: ["channel@1"],
  setup(ctx) {
    ctx.provide("channel@1", channel);
  },
});
