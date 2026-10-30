import { startTestRedis } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createKv } from "../../src/ctx/kv.js";
import { createLock } from "../../src/ctx/lock.js";
import { LockService } from "../../src/infra/lock/lock.service.js";
import { createLogger } from "../../src/log.js";

let box: Awaited<ReturnType<typeof startTestRedis>>;
let redis: Redis;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  box = await startTestRedis({ shared: true });
  redis = new Redis(box.url);
});
afterAll(async () => {
  redis.disconnect();
  await box.stop();
});

describe("ctx.kv", () => {
  it("set 后 get 取回，实际键为 cap:<ns>:kv:<key>", async () => {
    const kv = createKv(redis, "kv-a");
    await kv.set("k", "v", { ttlSeconds: 60 });
    expect(await kv.get("k")).toBe("v");
    expect(await redis.get("cap:kv-a:kv:k")).toBe("v");
    await kv.del("k");
    expect(await kv.get("k")).toBeNull();
  });

  it("ttlSeconds 缺失、非整数或 <= 0 抛 TypeError", async () => {
    const kv = createKv(redis, "kv-b");
    // biome-ignore lint/suspicious/noExplicitAny: 故意传错误参数
    const bad = kv as any;
    await expect(bad.set("k", "v")).rejects.toThrow(/ttlSeconds/);
    await expect(bad.set("k", "v", {})).rejects.toThrow(TypeError);
    await expect(kv.set("k", "v", { ttlSeconds: 0 })).rejects.toThrow(/ttlSeconds/);
    await expect(kv.set("k", "v", { ttlSeconds: -1 })).rejects.toThrow(/ttlSeconds/);
    await expect(kv.set("k", "v", { ttlSeconds: 1.5 })).rejects.toThrow(/ttlSeconds/);
    await expect(kv.incr("k", { ttlSeconds: 0 })).rejects.toThrow(/ttlSeconds/);
    await expect(bad.incr("k")).rejects.toThrow(/ttlSeconds/);
  });

  it("ttlSeconds 到期后 get 为 null", async () => {
    const kv = createKv(redis, "kv-c");
    await kv.set("k", "v", { ttlSeconds: 1 });
    await sleep(1500);
    expect(await kv.get("k")).toBeNull();
  });

  it("不同 namespace 同名键互不可见", async () => {
    const a = createKv(redis, "kv-d1");
    const b = createKv(redis, "kv-d2");
    await a.set("k", "va", { ttlSeconds: 60 });
    expect(await b.get("k")).toBeNull();
    await b.set("k", "vb", { ttlSeconds: 60 });
    expect(await a.get("k")).toBe("va");
  });

  it("incr 递增，首次创建设 TTL，后续不重置 TTL", async () => {
    const kv = createKv(redis, "kv-e");
    expect(await kv.incr("n", { ttlSeconds: 2 })).toBe(1);
    const t1 = await redis.pttl("cap:kv-e:kv:n");
    expect(t1).toBeGreaterThan(0);
    expect(t1).toBeLessThanOrEqual(2000);
    await sleep(700);
    expect(await kv.incr("n", { ttlSeconds: 100 })).toBe(2);
    const t2 = await redis.pttl("cap:kv-e:kv:n");
    expect(t2).toBeLessThan(t1);
    await sleep(1500);
    expect(await kv.get("n")).toBeNull();
  });

  it("kv 的 lock:x 键与持有中的锁 x 互不影响", async () => {
    const kv = createKv(redis, "kv-f");
    const lock = createLock(new LockService(redis, createLogger("error")), "kv-f");
    const held = await lock.acquire("x", { ttlMs: 10_000 });
    expect(held).not.toBeNull();
    await kv.set("lock:x", "hijack", { ttlSeconds: 60 });
    await kv.del("lock:x");
    // 锁仍在：再次 acquire 失败，持有者仍能续期
    expect(await lock.acquire("x", { ttlMs: 10_000 })).toBeNull();
    expect(await held?.renew()).toBe(true);
    await held?.release();
  });

  it("非法 namespace 抛 TypeError", () => {
    for (const ns of ["", "A", "a", "1ab", "a:b", "a.b", "a_b", `a${"b".repeat(41)}`]) {
      expect(() => createKv(redis, ns)).toThrow(TypeError);
    }
  });
});
