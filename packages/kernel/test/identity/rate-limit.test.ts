import { startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LoginRateLimiter, loginFailKey } from "../../src/identity/rate-limit.js";

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
  it("同一登录名前 10 次 reserve 放行，第 11 次拒绝，retryAfterSeconds ∈ (0, 900]；succeeded 后恢复", async () => {
    const rl = new LoginRateLimiter(r1);
    for (let i = 0; i < 10; i++) {
      expect(await rl.reserve("alice", `10.0.0.${i}`)).toEqual({ allowed: true });
    }
    const r = await rl.reserve("alice", "10.0.0.99");
    expect(r.allowed).toBe(false);
    if (r.allowed) throw new Error("unreachable");
    expect(r.retryAfterSeconds).toBeGreaterThan(0);
    expect(r.retryAfterSeconds).toBeLessThanOrEqual(900);
    // 其他登录名不受影响
    expect(await rl.reserve("bob", "10.0.0.99")).toEqual({ allowed: true });
    await rl.succeeded("alice", "10.0.0.99");
    expect(await rl.reserve("alice", "10.0.0.1")).toEqual({ allowed: true });
  });

  it("登录名按规范化（大小写、空白）计数", async () => {
    const rl = new LoginRateLimiter(r1);
    for (let i = 0; i < 5; i++) await rl.reserve("Alice", "10.0.0.1");
    for (let i = 0; i < 5; i++) await rl.reserve(" alice ", "10.0.0.1");
    expect((await rl.reserve("ALICE", "10.0.0.1")).allowed).toBe(false);
  });

  it("两个实例（两条 Redis 连接）交替 reserve，合计第 11 次即拒绝", async () => {
    const a = new LoginRateLimiter(r1);
    const b = new LoginRateLimiter(r2);
    for (let i = 0; i < 10; i++) {
      expect((await (i % 2 === 0 ? a : b).reserve("alice", "10.0.0.1")).allowed).toBe(true);
    }
    expect((await a.reserve("alice", "10.0.0.1")).allowed).toBe(false);
    expect((await b.reserve("alice", "10.0.0.1")).allowed).toBe(false);
  });

  it("并发 30 次 reserve 同一登录名：恰好 10 次放行", async () => {
    const rl = [new LoginRateLimiter(r1), new LoginRateLimiter(r2)];
    const rs = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        (rl[i % 2] as LoginRateLimiter).reserve("alice", "10.0.0.1"),
      ),
    );
    expect(rs.filter((r) => r.allowed)).toHaveLength(10);
  });

  it("同一 IP 前 50 次（不同登录名）放行，第 51 次拒绝该 IP 的任何登录名", async () => {
    const rl = new LoginRateLimiter(r1);
    for (let i = 0; i < 50; i++)
      expect((await rl.reserve(`user${i}`, "10.0.0.9")).allowed).toBe(true);
    expect((await rl.reserve("someone", "10.0.0.9")).allowed).toBe(false);
    expect(await rl.reserve("someone", "10.0.0.8")).toEqual({ allowed: true });
  });

  it("succeeded：删登录名计数，IP 计数减一（不低于 0，不留无 TTL 的键）", async () => {
    const rl = new LoginRateLimiter(r1);
    await rl.reserve("alice", "10.0.0.1");
    await rl.reserve("bob", "10.0.0.1");
    await rl.succeeded("alice", "10.0.0.1");
    expect(await r1.exists(loginFailKey.login("alice"))).toBe(0);
    expect(await r1.get(loginFailKey.ip("10.0.0.1"))).toBe("1");
    await rl.succeeded("bob", "10.0.0.1");
    await rl.succeeded("bob", "10.0.0.1");
    expect(await r1.exists(loginFailKey.ip("10.0.0.1"))).toBe(0);
    // IP 键不存在时 succeeded 不会凭空建出负数键
    await rl.succeeded("carol", "10.0.0.2");
    expect(await r1.exists(loginFailKey.ip("10.0.0.2"))).toBe(0);
  });

  it("每个计数键都有 TTL", async () => {
    const rl = new LoginRateLimiter(r1);
    await rl.reserve("alice", "::1");
    await rl.reserve("alice", "::1");
    const keys = await r1.keys("capk:login-fail:*");
    expect(keys).toHaveLength(2);
    expect(keys).toContain("capk:login-fail:ip:::1");
    expect(keys).toContain(loginFailKey.login("alice"));
    expect(loginFailKey.login("alice")).toMatch(/^capk:login-fail:l:[0-9a-f]{64}$/);
    for (const k of keys) {
      const ttl = await r1.ttl(k);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(900);
    }
  });
});
