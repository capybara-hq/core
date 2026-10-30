import { startTestRedis, type TestContainer } from "@capybara-hq/testing";
import type { FastifyReply, FastifyRequest } from "fastify";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../src/errors.js";
import { CredentialThrottler } from "../../src/infra/throttler/credential-throttler.js";
import { RedisThrottlerStorage } from "../../src/infra/throttler/redis-throttler-storage.js";
import { createLogger, type KernelLogger } from "../../src/log.js";

let rd: TestContainer;
let r1: Redis;
let r2: Redis;
beforeAll(async () => {
  rd = await startTestRedis({ shared: true });
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

const log = createLogger("error") as KernelLogger;
const make = (redis: Redis) => new CredentialThrottler(new RedisThrottlerStorage(redis, log));

const LOGIN = ["login", "login-ip", "login-account"];
const ACCT = ["change-password", "change-password-ip"];
const INV = ["invitation", "invitation-ip"];
const SETUP = ["setup-token", "setup-ip"];

const loginReq = (login: string, ip: string) => ({ body: { login }, ip }) as FastifyRequest;
const acctReq = (id: string, ip: string) => ({ principal: { account: { id } }, ip }) as never;
const invReq = (token: string, ip: string) => ({ params: { token }, ip }) as never;
const setupReq = (ip: string) => ({ ip }) as never;

type Res = { allowed: true } | { allowed: false; retry: number; message: string };
async function reserve(
  ct: CredentialThrottler,
  names: string[],
  req: FastifyRequest,
): Promise<Res> {
  const header = vi.fn();
  try {
    await ct.reserve(names, req, { header } as unknown as FastifyReply);
    return { allowed: true };
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    expect(e.code).toBe("auth.rate_limited");
    expect(e.status).toBe(429);
    return { allowed: false, retry: Number(header.mock.calls[0]?.[1]), message: e.message };
  }
}
const allowed = async (ct: CredentialThrottler, names: string[], req: FastifyRequest) =>
  (await reserve(ct, names, req)).allowed;

const keysOf = (pattern: string) => r1.keys(pattern);
const count = async (name: string) => {
  const ks = await keysOf(`throttler:*:${name}:*`);
  return Promise.all(ks.map((k) => r1.get(k)));
};

describe("CredentialThrottler.reserve (login)", () => {
  it("one login from 11 IPs: none rejected", async () => {
    const ct = make(r1);
    for (let i = 0; i < 11; i++)
      expect(await allowed(ct, LOGIN, loginReq("alice", `10.0.0.${i}`))).toBe(true);
  });

  it("(login, IP): 10 pass, the 11th is rejected with today's message and retry in (0, 900]; other IP / login unaffected", async () => {
    const ct = make(r1);
    for (let i = 0; i < 10; i++)
      expect(await allowed(ct, LOGIN, loginReq("alice", "10.0.0.1"))).toBe(true);
    const r = await reserve(ct, LOGIN, loginReq("alice", "10.0.0.1"));
    expect(r.allowed).toBe(false);
    if (r.allowed) throw new Error("unreachable");
    expect(r.message).toBe("Too many failed login attempts; try again later");
    expect(r.retry).toBeGreaterThan(0);
    expect(r.retry).toBeLessThanOrEqual(900);
    expect(await allowed(ct, LOGIN, loginReq("alice", "10.0.0.2"))).toBe(true);
    expect(await allowed(ct, LOGIN, loginReq("bob", "10.0.0.1"))).toBe(true);
  });

  it("one login across 100 IPs, the 101st is rejected (per-login cap)", async () => {
    const ct = make(r1);
    for (let i = 0; i < 100; i++) {
      expect(await allowed(ct, LOGIN, loginReq("alice", `10.0.${i >> 8}.${i & 255}`))).toBe(true);
    }
    expect(await allowed(ct, LOGIN, loginReq("alice", "10.9.9.9"))).toBe(false);
    expect(await allowed(ct, LOGIN, loginReq("bob", "10.9.9.9"))).toBe(true);
  });

  it("all or nothing: a rejected attempt counts on no dimension", async () => {
    const ct = make(r1);
    for (let i = 0; i < 10; i++) await reserve(ct, LOGIN, loginReq("admin", "203.0.113.7"));
    expect((await count("login")).sort()).toEqual(["10"]);
    expect((await count("login-ip")).sort()).toEqual(["10"]);
    expect((await count("login-account")).sort()).toEqual(["10"]);
    for (let i = 0; i < 140; i++) {
      expect(await allowed(ct, LOGIN, loginReq("admin", "203.0.113.7"))).toBe(false);
    }
    expect(await count("login")).toEqual(["10"]);
    expect(await count("login-ip")).toEqual(["10"]);
    expect(await count("login-account")).toEqual(["10"]);
    // the owner from another IP still may try
    expect(await allowed(ct, LOGIN, loginReq("admin", "198.51.100.20"))).toBe(true);
  });

  it("a request rejected on the IP dimension does not count on (login, IP)", async () => {
    const ct = make(r1);
    for (let i = 0; i < 50; i++) await reserve(ct, LOGIN, loginReq(`user${i}`, "10.0.0.9"));
    expect(await allowed(ct, LOGIN, loginReq("someone", "10.0.0.9"))).toBe(false);
    // "someone" was never counted anywhere
    expect(await allowed(ct, LOGIN, loginReq("someone", "10.0.0.8"))).toBe(true);
    expect((await count("login-account")).filter((c) => c !== "1")).toEqual([]);
    expect(await count("login-account")).toHaveLength(51);
  });

  it("retry-after is the largest TTL among the keys at their limit", async () => {
    const ct = make(r1);
    for (let i = 0; i < 10; i++) await reserve(ct, LOGIN, loginReq("alice", "10.0.0.9"));
    const keys = await keysOf("throttler:*");
    const li = keys.find((k) => k.includes(":login:")) as string;
    const ip = keys.find((k) => k.includes(":login-ip:")) as string;
    const acct = keys.find((k) => k.includes(":login-account:")) as string;
    await r1.set(ip, "50", "PX", 300_000); // at its limit too, with a shorter TTL
    await r1.pexpire(li, 600_000);
    await r1.pexpire(acct, 800_000); // not at its limit: must not count
    const r = await reserve(ct, LOGIN, loginReq("alice", "10.0.0.9"));
    if (r.allowed) throw new Error("expected rejection");
    expect(r.retry).toBeGreaterThan(300);
    expect(r.retry).toBeLessThanOrEqual(600);
  });

  it("normalizes the login (case, spaces)", async () => {
    const ct = make(r1);
    for (let i = 0; i < 5; i++) await reserve(ct, LOGIN, loginReq("Alice", "10.0.0.1"));
    for (let i = 0; i < 5; i++) await reserve(ct, LOGIN, loginReq(" alice ", "10.0.0.1"));
    expect(await allowed(ct, LOGIN, loginReq("ALICE", "10.0.0.1"))).toBe(false);
  });

  it("two instances on two connections: the 11th overall is rejected", async () => {
    const [a, b] = [make(r1), make(r2)];
    for (let i = 0; i < 10; i++) {
      expect(await allowed(i % 2 === 0 ? a : b, LOGIN, loginReq("alice", "10.0.0.1"))).toBe(true);
    }
    expect(await allowed(a, LOGIN, loginReq("alice", "10.0.0.1"))).toBe(false);
    expect(await allowed(b, LOGIN, loginReq("alice", "10.0.0.1"))).toBe(false);
  });

  it("30 concurrent attempts on one (login, IP): exactly 10 pass", async () => {
    const cts = [make(r1), make(r2)];
    const rs = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        allowed(cts[i % 2] as CredentialThrottler, LOGIN, loginReq("alice", "10.0.0.1")),
      ),
    );
    expect(rs.filter(Boolean)).toHaveLength(10);
  });

  it("every counter has the window TTL; the keys of one group share one hash tag", async () => {
    const ct = make(r1);
    await reserve(ct, LOGIN, loginReq("alice", "::1"));
    await reserve(ct, LOGIN, loginReq("alice", "::1"));
    const keys = await keysOf("throttler:*");
    expect(keys).toHaveLength(3);
    for (const k of keys) {
      expect(k).toMatch(/^throttler:\{cred:login\}:login(-ip|-account)?:[0-9a-f]{64}$/);
      const ttl = await r1.ttl(k);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(900);
    }
  });
});

describe("CredentialThrottler.succeeded", () => {
  it("login: clears (login, IP) and login counters, refunds one on the IP counter (never below 0)", async () => {
    const ct = make(r1);
    const req = (l: string, ip: string) => loginReq(l, ip);
    await reserve(ct, LOGIN, req("alice", "10.0.0.1"));
    await reserve(ct, LOGIN, req("bob", "10.0.0.1"));
    await ct.succeeded(LOGIN, req("alice", "10.0.0.1"));
    expect(await count("login")).toEqual(["1"]); // only bob's pair remains
    expect(await count("login-account")).toEqual(["1"]);
    expect(await count("login-ip")).toEqual(["1"]);
    await ct.succeeded(LOGIN, req("bob", "10.0.0.1"));
    await ct.succeeded(LOGIN, req("bob", "10.0.0.1"));
    expect(await keysOf("throttler:*")).toEqual([]);
    // no key is created out of nothing
    await ct.succeeded(LOGIN, req("carol", "10.0.0.2"));
    expect(await keysOf("throttler:*")).toEqual([]);
  });

  it("scoped routes: the key counter is cleared and the scope's IP counter refunded", async () => {
    const ct = make(r1);
    for (let i = 0; i < 10; i++) await reserve(ct, ACCT, acctReq("acc-1", "10.0.0.1"));
    await ct.succeeded(ACCT, acctReq("acc-1", "10.0.0.1"));
    expect(await count("change-password-ip")).toEqual(["9"]);
    expect(await count("change-password")).toEqual([]);
    expect(await allowed(ct, ACCT, acctReq("acc-1", "10.0.0.1"))).toBe(true);
  });
});

describe("CredentialThrottler scoped routes", () => {
  it("change password: 10 per account, 50 per IP; rejected attempts count nowhere; scopes are separate from login", async () => {
    const ct = make(r1);
    for (let i = 0; i < 10; i++)
      expect(await allowed(ct, ACCT, acctReq("acc-1", "10.0.0.1"))).toBe(true);
    const r = await reserve(ct, ACCT, acctReq("acc-1", "10.0.0.1"));
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.message).toBe("Too many failed password attempts; try again later");
    for (let i = 0; i < 20; i++) await reserve(ct, ACCT, acctReq("acc-1", "10.0.0.1"));
    expect(await count("change-password-ip")).toEqual(["10"]);
    // same account from another IP is still rejected by the account counter
    expect(await allowed(ct, ACCT, acctReq("acc-1", "10.0.0.2"))).toBe(false);
    // the login IP budget is untouched
    for (let i = 0; i < 50; i++)
      expect(await allowed(ct, LOGIN, loginReq(`u${i}`, "10.0.0.1"))).toBe(true);
    // one IP, 50 accounts
    for (let i = 0; i < 40; i++) await reserve(ct, ACCT, acctReq(`a${i}`, "10.0.0.1"));
    expect(await allowed(ct, ACCT, acctReq("a-x", "10.0.0.1"))).toBe(false);
  });

  it("invitation: 10 per token, 20 per IP", async () => {
    const ct = make(r1);
    for (let i = 0; i < 10; i++)
      expect(await allowed(ct, INV, invReq("t1", "10.0.0.1"))).toBe(true);
    const r = await reserve(ct, INV, invReq("t1", "10.0.0.2"));
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.message).toBe("Too many invitation attempts; try again later");
    for (let i = 0; i < 10; i++) await reserve(ct, INV, invReq(`x${i}`, "10.0.0.1"));
    expect(await allowed(ct, INV, invReq("t-new", "10.0.0.1"))).toBe(false);
    expect(await allowed(ct, INV, invReq("t-new", "10.0.0.3"))).toBe(true);
  });

  it("setup: 100 total, 10 per IP", async () => {
    const ct = make(r1);
    for (let i = 0; i < 10; i++) expect(await allowed(ct, SETUP, setupReq("10.0.0.1"))).toBe(true);
    const r = await reserve(ct, SETUP, setupReq("10.0.0.1"));
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.message).toBe("Too many setup attempts; try again later");
    expect(await allowed(ct, SETUP, setupReq("10.0.0.2"))).toBe(true);
  });
});

describe("CredentialThrottler failure and misuse", () => {
  it("fails CLOSED: a Redis error propagates, nothing is allowed", async () => {
    const ct = make(r1);
    const spy = vi.spyOn(r1, "eval").mockRejectedValue(new Error("connection lost"));
    await expect(reserve(ct, LOGIN, loginReq("alice", "10.0.0.1"))).rejects.toThrow(
      "connection lost",
    );
    await expect(ct.succeeded(LOGIN, loginReq("alice", "10.0.0.1"))).rejects.toThrow(
      "connection lost",
    );
    spy.mockRestore();
  });

  it("rejects unknown names and names of different groups", async () => {
    const ct = make(r1);
    await expect(reserve(ct, ["nope"], loginReq("a", "1.1.1.1"))).rejects.toThrow(/unknown/);
    await expect(reserve(ct, ["login", "setup-ip"], loginReq("a", "1.1.1.1"))).rejects.toThrow(
      /group/,
    );
  });
});
