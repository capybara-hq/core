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

describe("LoginRateLimiter（按登录名 + IP 计数）", () => {
  it("同一登录名从 11 个不同 IP 各错 1 次 → 都不被拒", async () => {
    const rl = new LoginRateLimiter(r1);
    for (let i = 0; i < 11; i++) {
      expect(await rl.reserve("alice", `10.0.0.${i}`)).toEqual({ allowed: true });
    }
  });

  it("同一 (登录名, IP) 前 10 次放行，第 11 次拒绝，retryAfterSeconds ∈ (0, 900]；同登录名别的 IP、同 IP 别的登录名不受影响", async () => {
    const rl = new LoginRateLimiter(r1);
    for (let i = 0; i < 10; i++) {
      expect(await rl.reserve("alice", "10.0.0.1")).toEqual({ allowed: true });
    }
    const r = await rl.reserve("alice", "10.0.0.1");
    expect(r.allowed).toBe(false);
    if (r.allowed) throw new Error("unreachable");
    expect(r.retryAfterSeconds).toBeGreaterThan(0);
    expect(r.retryAfterSeconds).toBeLessThanOrEqual(900);
    expect(await rl.reserve("alice", "10.0.0.2")).toEqual({ allowed: true });
    expect(await rl.reserve("bob", "10.0.0.1")).toEqual({ allowed: true });
  });

  it("同一登录名从 101 个不同 IP 各错 1 次 → 第 101 次拒绝（单登录名全局上限）", async () => {
    const rl = new LoginRateLimiter(r1);
    for (let i = 0; i < 100; i++) {
      expect((await rl.reserve("alice", `10.0.${i >> 8}.${i & 255}`)).allowed).toBe(true);
    }
    expect((await rl.reserve("alice", "10.9.9.9")).allowed).toBe(false);
    expect(await rl.reserve("bob", "10.9.9.9")).toEqual({ allowed: true });
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

  it("并发 30 次 reserve 同一 (登录名, IP)：恰好 10 次放行", async () => {
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

  it("succeeded：删 li 与 l 键，IP 计数减一（不低于 0，不留无 TTL 的键）", async () => {
    const rl = new LoginRateLimiter(r1);
    await rl.reserve("alice", "10.0.0.1");
    await rl.reserve("bob", "10.0.0.1");
    expect(await r1.exists(loginFailKey.loginIp("alice", "10.0.0.1"))).toBe(1);
    await rl.succeeded("alice", "10.0.0.1");
    expect(await r1.exists(loginFailKey.loginIp("alice", "10.0.0.1"))).toBe(0);
    expect(await r1.exists(loginFailKey.login("alice"))).toBe(0);
    expect(await r1.exists(loginFailKey.loginIp("bob", "10.0.0.1"))).toBe(1);
    expect(await r1.get(loginFailKey.ip("10.0.0.1"))).toBe("1");
    await rl.succeeded("bob", "10.0.0.1");
    await rl.succeeded("bob", "10.0.0.1");
    expect(await r1.exists(loginFailKey.ip("10.0.0.1"))).toBe(0);
    // IP 键不存在时 succeeded 不会凭空建出负数键
    await rl.succeeded("carol", "10.0.0.2");
    expect(await r1.exists(loginFailKey.ip("10.0.0.2"))).toBe(0);
  });

  it("每个计数键都有 TTL；键名格式", async () => {
    const rl = new LoginRateLimiter(r1);
    await rl.reserve("alice", "::1");
    await rl.reserve("alice", "::1");
    const keys = await r1.keys("capk:login-fail:*");
    expect(keys.sort()).toEqual(
      [
        loginFailKey.ip("::1"),
        loginFailKey.login("alice"),
        loginFailKey.loginIp("alice", "::1"),
      ].sort(),
    );
    expect(loginFailKey.ip("::1")).toBe("capk:login-fail:ip:::1");
    expect(loginFailKey.login("alice")).toMatch(/^capk:login-fail:l:[0-9a-f]{64}$/);
    expect(loginFailKey.loginIp("alice", "::1")).toMatch(
      /^capk:login-fail:li:[0-9a-f]{64}:[0-9a-f]{64}$/,
    );
    for (const k of keys) {
      const ttl = await r1.ttl(k);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(900);
    }
  });
});

describe("LoginRateLimiter.reserveScoped", () => {
  it("按 (scope, key) 与 scope 内的 IP 计数，上限由调用方给；不消耗登录的 IP 额度", async () => {
    const rl = new LoginRateLimiter(r1);
    for (let i = 0; i < 10; i++) {
      expect(await rl.reserveScoped("acct", "acc-1", "10.0.0.1", 10)).toEqual({ allowed: true });
    }
    expect((await rl.reserveScoped("acct", "acc-1", "10.0.0.1", 10)).allowed).toBe(false);
    // 同一 key 换 IP 仍被 key 计数拒绝
    expect((await rl.reserveScoped("acct", "acc-1", "10.0.0.2", 10)).allowed).toBe(false);
    // 别的 scope 互不影响
    expect(await rl.reserveScoped("inv", "acc-1", "10.0.0.1", 10)).toEqual({ allowed: true });
    // 登录的 IP 计数没被消耗：同 IP 仍有完整的 50 次登录额度
    expect(await r1.exists(loginFailKey.ip("10.0.0.1"))).toBe(0);
    for (let i = 0; i < 50; i++) {
      expect((await rl.reserve(`user${i}`, "10.0.0.1")).allowed).toBe(true);
    }
    expect(await r1.exists("capk:rl:acct:ip:10.0.0.1")).toBe(1);
    const scoped = await r1.keys("capk:rl:*");
    expect(scoped.length).toBeGreaterThan(0);
    for (const k of scoped) {
      const ttl = await r1.ttl(k);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(900);
    }
  });

  it("scope 内同一 IP 换不同 key 也受 IP 上限约束（默认 50，可由调用方指定）", async () => {
    const rl = new LoginRateLimiter(r1);
    for (let i = 0; i < 50; i++) {
      expect((await rl.reserveScoped("acct", `acc-${i}`, "10.0.0.1", 10)).allowed).toBe(true);
    }
    expect((await rl.reserveScoped("acct", "acc-x", "10.0.0.1", 10)).allowed).toBe(false);
    for (let i = 0; i < 20; i++) {
      expect((await rl.reserveScoped("inv", `tok-${i}`, "10.0.0.1", 10, 20)).allowed).toBe(true);
    }
    expect((await rl.reserveScoped("inv", "tok-x", "10.0.0.1", 10, 20)).allowed).toBe(false);
    expect(await rl.reserveScoped("inv", "tok-x", "10.0.0.2", 10, 20)).toEqual({
      allowed: true,
    });
  });

  it("succeededScoped 删 key 计数、IP 计数减一", async () => {
    const rl = new LoginRateLimiter(r1);
    for (let i = 0; i < 10; i++) await rl.reserveScoped("acct", "acc-1", "10.0.0.1", 10);
    await rl.succeededScoped("acct", "acc-1", "10.0.0.1");
    expect(await r1.get("capk:rl:acct:ip:10.0.0.1")).toBe("9");
    expect(await rl.reserveScoped("acct", "acc-1", "10.0.0.1", 10)).toEqual({ allowed: true });
  });
});
