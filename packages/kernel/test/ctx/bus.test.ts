import { startTestRedis } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createBus, createBusSubscriber } from "../../src/ctx/bus.js";

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
});
