import type { ExtensionContext, Logger } from "@capybara-hq/plugin-sdk";
import type { Redis } from "ioredis";
import { assertNamespace } from "./namespace.js";

type RawHandler = (message: string) => void;

/** 一个进程共用的订阅连接：由内核创建并传入 createBus，不使用模块级状态。 */
export interface BusSubscriber {
  /** 订阅频道，返回取消函数；频道最后一个 handler 移除时真正 UNSUBSCRIBE。 */
  subscribe(channel: string, handler: RawHandler): Promise<() => Promise<void>>;
}

type ErrorLog = Pick<Logger, "error">;

/** 未注入 logger 时的兜底：输出到 stderr。 */
const consoleLog: ErrorLog = {
  error: (msg, fields) => console.error(`[bus] ${msg}`, fields ?? ""),
};

/** 调用 handler：同步抛错与返回 Promise 的 reject 都被吞掉并记录，保证 handler 间互相隔离。 */
function invokeIsolated(log: ErrorLog, label: string, fn: () => unknown): void {
  Promise.resolve()
    .then(fn)
    .catch((err) => log.error("bus handler threw", { channel: label, err }));
}

interface ChannelState {
  handlers: Set<RawHandler>;
  ready: Promise<void>;
}

/** 创建共享订阅者：首次订阅时才惰性打开唯一一条连接，并把频道多路复用到各 handler 集合。 */
export function createBusSubscriber(
  subFactory: () => Redis,
  log: ErrorLog = consoleLog,
): BusSubscriber & {
  close(): Promise<void>;
} {
  let conn: Redis | null = null;
  let closed = false;
  const channels = new Map<string, ChannelState>();

  const ensure = (): Redis => {
    if (conn) return conn;
    const c = subFactory();
    c.on("message", (channel: string, message: string) => {
      for (const h of [...(channels.get(channel)?.handlers ?? [])]) {
        invokeIsolated(log, channel, () => h(message));
      }
    });
    c.on("error", (err: Error) => log.error("bus subscriber connection error", { err }));
    conn = c;
    return c;
  };

  return {
    async subscribe(channel, handler) {
      if (closed) throw new Error("bus subscriber is closed");
      const c = ensure();
      let st = channels.get(channel);
      if (!st) {
        const handlers = new Set<RawHandler>();
        st = { handlers, ready: Promise.resolve() };
        channels.set(channel, st);
        const created = st;
        created.ready = c.subscribe(channel).then(() => undefined);
        created.ready.catch(() => {
          if (channels.get(channel) === created) channels.delete(channel);
        });
      }
      st.handlers.add(handler);
      try {
        await st.ready;
      } catch (err) {
        st.handlers.delete(handler);
        throw err;
      }
      let removed = false;
      const state = st;
      return async () => {
        if (removed) return;
        removed = true;
        state.handlers.delete(handler);
        if (state.handlers.size === 0 && channels.get(channel) === state) {
          channels.delete(channel);
          if (!closed) await c.unsubscribe(channel);
        }
      };
    },
    async close() {
      closed = true;
      channels.clear();
      const c = conn;
      conn = null;
      if (c) await c.quit().catch(() => c.disconnect());
    },
  };
}

/** 创建 ctx.bus：频道为 `cap:<namespace>:<topic>`，payload 为 JSON。 */
export function createBus(
  pub: Redis,
  subscriber: BusSubscriber,
  namespace: string,
  log: ErrorLog = consoleLog,
): ExtensionContext["bus"] {
  assertNamespace(namespace);
  const ch = (topic: string) => `cap:${namespace}:${topic}`;
  return {
    async publish(topic, payload) {
      await pub.publish(ch(topic), JSON.stringify(payload));
    },
    subscribe(topic, handler) {
      return subscriber.subscribe(ch(topic), (message) => {
        let payload: unknown;
        try {
          payload = JSON.parse(message);
        } catch {
          log.error("bus ignoring malformed message", { channel: ch(topic) });
          return;
        }
        invokeIsolated(log, ch(topic), () => handler(payload));
      });
    },
  };
}
