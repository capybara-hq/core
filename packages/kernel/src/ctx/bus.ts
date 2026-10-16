import type { PluginContext } from "@capybara-hq/plugin-sdk";
import type { Redis } from "ioredis";

type RawHandler = (message: string) => void;

/** 一个进程共用的订阅连接：由内核创建并传入 createBus，不使用模块级状态。 */
export interface BusSubscriber {
  /** 订阅频道，返回取消函数；频道最后一个 handler 移除时真正 UNSUBSCRIBE。 */
  subscribe(channel: string, handler: RawHandler): Promise<() => Promise<void>>;
}

/** 创建共享订阅者：首次订阅时才惰性打开唯一一条连接，并把频道多路复用到各 handler 集合。 */
export function createBusSubscriber(subFactory: () => Redis): BusSubscriber & {
  close(): Promise<void>;
} {
  let conn: Redis | null = null;
  const handlers = new Map<string, Set<RawHandler>>();

  const ensure = (): Redis => {
    if (conn) return conn;
    const c = subFactory();
    c.on("message", (channel: string, message: string) => {
      for (const h of [...(handlers.get(channel) ?? [])]) {
        try {
          h(message);
        } catch (err) {
          console.error(`[bus] handler for ${channel} threw`, err);
        }
      }
    });
    c.on("error", (err: Error) => console.error("[bus] subscriber connection error", err));
    conn = c;
    return c;
  };

  return {
    async subscribe(channel, handler) {
      const c = ensure();
      let set = handlers.get(channel);
      const first = !set;
      if (!set) {
        set = new Set();
        handlers.set(channel, set);
      }
      set.add(handler);
      if (first) await c.subscribe(channel);
      let removed = false;
      return async () => {
        if (removed) return;
        removed = true;
        const cur = handlers.get(channel);
        if (!cur) return;
        cur.delete(handler);
        if (cur.size === 0) {
          handlers.delete(channel);
          await c.unsubscribe(channel);
        }
      };
    },
    async close() {
      handlers.clear();
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
): PluginContext["bus"] {
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
          console.error(`[bus] ignoring malformed message on ${ch(topic)}`);
          return;
        }
        try {
          handler(payload);
        } catch (err) {
          console.error(`[bus] handler for ${ch(topic)} threw`, err);
        }
      });
    },
  };
}
