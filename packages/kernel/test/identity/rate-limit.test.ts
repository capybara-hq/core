import { startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LoginRateLimiter } from "../../src/identity/rate-limit.js";

let rd: TestContainer;
let r1: Redis;
let r2: Redis;

beforeAll(async () => {
  rd = await startTestRedis();
  r1 = new Redis(rd.url);
  r2 = new Redis(rd.url);
}, 120_000);
afterAll(async () => {
  r1.disconnect();
  r2.disconnect();
  await rd.stop();
});
beforeEach(async () => {
  await r1.flushdb();
});

describe("LoginRateLimiter", () => {
  it("同一登录名 10 次失败后拒绝，retryAfterSeconds ∈ (0, 900]；clear 后恢复", async () => {
    const rl = new LoginRateLimiter(r1);
    for (let i = 0; i < 9; i++) await rl.recordFailure("alice", "10.0.0.1");
    expect(await rl.check("alice", "10.0.0.1")).toEqual({ allowed: true });
    await rl.recordFailure("alice", "10.0.0.1");
    const r = await rl.check("alice", "10.0.0.2");
    expect(r.allowed).toBe(false);
    if (r.allowed) throw new Error("unreachable");
    expect(r.retryAfterSeconds).toBeGreaterThan(0);
    expect(r.retryAfterSeconds).toBeLessThanOrEqual(900);
    // 其他登录名不受影响
    expect(await rl.check("bob", "10.0.0.2")).toEqual({ allowed: true });
    await rl.clear("alice");
    expect(await rl.check("alice", "10.0.0.1")).toEqual({ allowed: true });
  });

  it("登录名按规范化（大小写、空白）计数", async () => {
    const rl = new LoginRateLimiter(r1);
    for (let i = 0; i < 5; i++) await rl.recordFailure("Alice", "10.0.0.1");
    for (let i = 0; i < 5; i++) await rl.recordFailure(" alice ", "10.0.0.1");
    expect((await rl.check("ALICE", "10.0.0.1")).allowed).toBe(false);
  });

  it("两个实例（两条 Redis 连接）交替记失败，合计 10 次即触发", async () => {
    const a = new LoginRateLimiter(r1);
    const b = new LoginRateLimiter(r2);
    for (let i = 0; i < 10; i++) await (i % 2 === 0 ? a : b).recordFailure("alice", "10.0.0.1");
    expect((await a.check("alice", "10.0.0.1")).allowed).toBe(false);
    expect((await b.check("alice", "10.0.0.1")).allowed).toBe(false);
  });

  it("同一 IP 50 次失败（不同登录名）后拒绝该 IP 的任何登录名", async () => {
    const rl = new LoginRateLimiter(r1);
    for (let i = 0; i < 50; i++) await rl.recordFailure(`user${i}`, "10.0.0.9");
    const r = await rl.check("someone", "10.0.0.9");
    expect(r.allowed).toBe(false);
    expect(await rl.check("someone", "10.0.0.8")).toEqual({ allowed: true });
  });

  it("每个计数键都有 TTL", async () => {
    const rl = new LoginRateLimiter(r1);
    await rl.recordFailure("alice", "::1");
    await rl.recordFailure("alice", "::1");
    const keys = await r1.keys("capk:login-fail:*");
    expect(keys).toHaveLength(2);
    expect(keys).toContain("capk:login-fail:ip:::1");
    expect(keys.some((k) => /^capk:login-fail:l:[0-9a-f]{64}$/.test(k))).toBe(true);
    for (const k of keys) {
      const ttl = await r1.ttl(k);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(900);
    }
  });
});
