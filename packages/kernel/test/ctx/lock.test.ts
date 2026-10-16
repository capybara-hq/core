import { startTestRedis } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLock } from "../../src/ctx/lock.js";

let box: Awaited<ReturnType<typeof startTestRedis>>;
let redis: Redis;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  box = await startTestRedis();
  redis = new Redis(box.url);
});
afterAll(async () => {
  redis.disconnect();
  await box.stop();
});

describe("ctx.lock", () => {
  it("A 持有时 B 拿不到；A release 后 B 能拿到；键带 lock 前缀", async () => {
    const lock = createLock(redis, "lk-a");
    const a = await lock.acquire("r", { ttlMs: 5000 });
    expect(a).not.toBeNull();
    expect(await redis.exists("cap:lk-a:lock:r")).toBe(1);
    expect(await lock.acquire("r", { ttlMs: 5000 })).toBeNull();
    await a?.release();
    const b = await lock.acquire("r", { ttlMs: 5000 });
    expect(b).not.toBeNull();
    await b?.release();
  });

  it("A 不释放，过期后 B 能拿到；A 之后 release 不会释放 B 的锁，renew 返回 false", async () => {
    const lock = createLock(redis, "lk-b");
    const a = await lock.acquire("r", { ttlMs: 500 });
    expect(a).not.toBeNull();
    await sleep(700);
    const b = await lock.acquire("r", { ttlMs: 5000 });
    expect(b).not.toBeNull();
    await expect(a?.release()).resolves.toBeUndefined();
    expect(await redis.exists("cap:lk-b:lock:r")).toBe(1);
    expect(await a?.renew()).toBe(false);
    expect(await lock.acquire("r", { ttlMs: 5000 })).toBeNull();
    await b?.release();
  });

  it("renew 在过期前返回 true 并延长", async () => {
    const lock = createLock(redis, "lk-c");
    const a = await lock.acquire("r", { ttlMs: 1000 });
    await sleep(600);
    expect(await a?.renew()).toBe(true);
    await sleep(600);
    expect(await lock.acquire("r", { ttlMs: 1000 })).toBeNull();
    await a?.release();
  });

  it("ttlMs 非正整数抛 TypeError", async () => {
    const lock = createLock(redis, "lk-d");
    await expect(lock.acquire("r", { ttlMs: 0 })).rejects.toThrow(/ttlMs/);
    await expect(lock.acquire("r", { ttlMs: 1.5 })).rejects.toThrow(TypeError);
    // biome-ignore lint/suspicious/noExplicitAny: 故意传错误参数
    await expect((lock as any).acquire("r")).rejects.toThrow(/ttlMs/);
  });
});
