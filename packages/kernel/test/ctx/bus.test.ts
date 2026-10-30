import { startTestRedis } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createBus, createBusSubscriber } from "../../src/ctx/bus.js";
import { currentStore, TransactionHost } from "../../src/infra/database/transaction-host.js";
import { createLogger } from "../../src/log.js";
import { logContext, withLogContext } from "../../src/log-context.js";

let box: Awaited<ReturnType<typeof startTestRedis>>;
let admin: Redis;
const opened: Redis[] = [];
const conn = () => {
  const r = new Redis(box.url);
  opened.push(r);
  return r;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean | Promise<boolean>, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await sleep(20);
  }
  throw new Error("until: timeout");
};
const numsub = async (ch: string) => Number((await admin.pubsub("NUMSUB", ch))[1]);

beforeAll(async () => {
  box = await startTestRedis();
  admin = new Redis(box.url);
});
afterAll(async () => {
  admin.disconnect();
  for (const r of opened) r.disconnect();
  await box.stop();
});

function replica(ns: string) {
  const sub = createBusSubscriber(conn);
  return { bus: createBus(conn(), sub, ns), sub };
}

describe("ctx.bus", () => {
  it("跨副本投递相同 payload，取消订阅后不再收到", async () => {
    const a = replica("bus-a");
    const b = replica("bus-a");
    const got: unknown[] = [];
    const off = await b.bus.subscribe("t", (p) => got.push(p));
    await a.bus.publish("t", { x: 1, y: ["z"] });
    await until(() => got.length === 1);
    expect(got[0]).toEqual({ x: 1, y: ["z"] });
    await off();
    await a.bus.publish("t", { x: 2 });
    await sleep(200);
    expect(got).toHaveLength(1);
    await a.sub.close();
    await b.sub.close();
  });

  it("命名空间隔离", async () => {
    const a = replica("bus-n1");
    const b = replica("bus-n2");
    const got: unknown[] = [];
    await b.bus.subscribe("t", (p) => got.push(p));
    await a.bus.publish("t", 1);
    await sleep(200);
    expect(got).toHaveLength(0);
    await a.sub.close();
    await b.sub.close();
  });

  it("handler 抛错不影响其他 handler 与后续消息", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const a = replica("bus-t");
    const got: unknown[] = [];
    await a.bus.subscribe("t", () => {
      throw new Error("boom");
    });
    await a.bus.subscribe("t", (p) => got.push(p));
    await a.bus.publish("t", 1);
    await a.bus.publish("t", 2);
    await until(() => got.length === 2);
    expect(got).toEqual([1, 2]);
    spy.mockRestore();
    await a.sub.close();
  });

  it("非 JSON 消息被忽略", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const a = replica("bus-m");
    const got: unknown[] = [];
    await a.bus.subscribe("t", (p) => got.push(p));
    await admin.publish("cap:bus-m:t", "not json{");
    await a.bus.publish("t", "ok");
    await until(() => got.length === 1);
    expect(got).toEqual(["ok"]);
    spy.mockRestore();
    await a.sub.close();
  });

  it("最后一个 handler 退订时真正 UNSUBSCRIBE", async () => {
    const a = replica("bus-u");
    const ch = "cap:bus-u:t";
    const off1 = await a.bus.subscribe("t", () => {});
    const off2 = await a.bus.subscribe("t", () => {});
    expect(await numsub(ch)).toBe(1);
    await off1();
    expect(await numsub(ch)).toBe(1);
    await off2();
    expect(await numsub(ch)).toBe(0);
    await a.sub.close();
  });

  it("async handler reject 不产生 unhandledRejection 且不影响其他 handler", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    const a = replica("bus-async");
    const got: unknown[] = [];
    await a.bus.subscribe("t", (async () => {
      throw new Error("async boom");
    }) as (p: unknown) => void);
    await a.bus.subscribe("t", (p) => got.push(p));
    await a.bus.publish("t", 1);
    await until(() => got.length === 1);
    await sleep(100);
    process.off("unhandledRejection", onUnhandled);
    expect(unhandled).toHaveLength(0);
    spy.mockRestore();
    await a.sub.close();
  });

  it("并发 subscribe 同频道：都等到 SUBSCRIBE 确认，随后立即 publish 都能收到", async () => {
    const a = replica("bus-conc");
    const g1: unknown[] = [];
    const g2: unknown[] = [];
    await Promise.all([
      a.bus.subscribe("t", (p) => g1.push(p)),
      a.bus.subscribe("t", (p) => g2.push(p)),
    ]);
    await a.bus.publish("t", 7);
    await until(() => g1.length === 1 && g2.length === 1);
    await a.sub.close();
  });

  it("SUBSCRIBE 失败：subscribe 抛错并回滚，之后同频道可再订阅", async () => {
    const real = conn();
    let fail = true;
    const fake = new Proxy(real, {
      get(t, prop) {
        if (prop === "subscribe") {
          return async (...args: string[]) => {
            if (fail) {
              fail = false;
              throw new Error("subscribe failed");
            }
            return t.subscribe(...args);
          };
        }
        const v = Reflect.get(t, prop, t);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    const sub = createBusSubscriber(() => fake);
    const bus = createBus(conn(), sub, "bus-fail");
    await expect(bus.subscribe("t", () => {})).rejects.toThrow(/subscribe failed/);
    const got: unknown[] = [];
    await bus.subscribe("t", (p) => got.push(p));
    await bus.publish("t", 1);
    await until(() => got.length === 1);
    await sub.close();
  });

  it("close 之后 subscribe 抛 closed", async () => {
    const a = replica("bus-closed");
    await a.sub.close();
    await expect(a.bus.subscribe("t", () => {})).rejects.toThrow(/closed/);
  });

  it("handlers run outside the transaction and log context of the first subscriber", async () => {
    const r = replica("ctxiso");
    const seen: { tx: boolean; reqId: string | undefined }[] = [];
    // a transaction host on a stub pool: the first subscribe happens inside an open transaction
    // and a request's log context, which stay open while the message arrives
    const trx = {};
    const pool = {
      transaction: () => ({ execute: (fn: (t: unknown) => Promise<unknown>) => fn(trx) }),
    };
    const host = new TransactionHost(pool as never, createLogger("error", { write: () => {} }));
    let close!: () => void;
    const open = new Promise<void>((resolve) => {
      close = resolve;
    });
    const subscribed = withLogContext({ reqId: "req-1" }, () =>
      host.run(async () => {
        await r.bus.subscribe("t", () => {
          seen.push({ tx: currentStore() !== undefined, reqId: logContext()?.reqId });
        });
        await open;
      }),
    );
    await until(async () => (await numsub("cap:ctxiso:t")) === 1);
    await r.bus.publish("t", { n: 1 });
    await until(() => seen.length === 1);
    close();
    await subscribed;
    expect(seen).toEqual([{ tx: false, reqId: undefined }]);
    await r.sub.close();
  });

  it("非法 namespace 抛 TypeError", () => {
    const sub = createBusSubscriber(conn);
    expect(() => createBus(admin, sub, "a:b")).toThrow(TypeError);
    expect(() => createBus(admin, sub, "")).toThrow(TypeError);
  });
});
