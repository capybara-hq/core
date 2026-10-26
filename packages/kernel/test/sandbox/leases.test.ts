import { startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../src/errors.js";
import {
  SANDBOX_BUSY_PREFIX,
  SANDBOX_LOCK_PREFIX,
  type SandboxLease,
  SandboxLeases,
  SandboxLockLostError,
  SandboxPathBusyError,
} from "../../src/sandbox/leases.js";

/**
 * Shared and exclusive sandbox leases (sub-agents spec §10.3): Redis protocol only, against a real
 * Valkey. Two clients stand for two replicas.
 */
let rd: TestContainer;
let redisA: Redis;
let redisB: Redis;
const log = { warn: () => {} };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const never = () => new AbortController().signal;

beforeAll(async () => {
  rd = await startTestRedis({ shared: true });
  redisA = new Redis(rd.url);
  redisB = new Redis(rd.url);
});
afterAll(async () => {
  redisA?.disconnect();
  redisB?.disconnect();
  await rd?.stop();
});
beforeEach(async () => {
  await redisA.flushdb();
});

type LeaseOpts = { ttlMs?: number; pollMs?: number; pathTtlMs?: number };
const leasesA = (o: LeaseOpts = {}) => new SandboxLeases({ redis: redisA, log, pollMs: 10, ...o });
const leasesB = (o: LeaseOpts = {}) => new SandboxLeases({ redis: redisB, log, pollMs: 10, ...o });

/** Resolves to the settled state of `p` after `ms` without waiting for it. */
async function settledWithin<T>(p: Promise<T>, ms: number): Promise<"pending" | "done"> {
  return Promise.race([p.then(() => "done" as const), sleep(ms).then(() => "pending" as const)]);
}

/** Every `capk:` key present has a TTL. */
async function expectAllKeysExpire(): Promise<void> {
  const keys = await redisA.keys("capk:*");
  for (const k of keys) expect(await redisA.pttl(k), k).toBeGreaterThan(0);
}

describe("SandboxLeases", () => {
  it("up to cap shared leases coexist; cap+1 waits and gets in when one releases", async () => {
    const a = leasesA();
    const b = leasesB();
    const l1 = await a.acquireShared("c1", 2, never(), 1000);
    const l2 = await b.acquireShared("c1", 2, never(), 1000);
    expect(l1.kind).toBe("shared");
    expect(await a.sharedCount("c1")).toBe(2);
    expect(await redisA.get(`${SANDBOX_LOCK_PREFIX}c1`)).toBe("shared");
    const third = a.acquireShared("c1", 2, never(), 2000);
    expect(await settledWithin(third, 100)).toBe("pending");
    await l2.release();
    const l3 = await third;
    expect(await a.sharedCount("c1")).toBe(2);
    await l1.release();
    await l3.release();
    expect(await a.sharedCount("c1")).toBe(0);
    expect(await redisA.exists(`${SANDBOX_LOCK_PREFIX}c1`)).toBe(0);
  });

  it("a shared waiter gets sandbox.busy after capMs", async () => {
    const a = leasesA();
    const l1 = await a.acquireShared("c1", 1, never(), 1000);
    const err = await a.acquireShared("c1", 1, never(), 80).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("sandbox.busy");
    await l1.release();
  });

  it("exclusive waits while shared exist; shared waits while exclusive exists", async () => {
    const a = leasesA();
    const b = leasesB();
    const s = await a.acquireShared("c1", 4, never(), 1000);
    expect(await b.tryExclusive("c1")).toBeNull();
    const ex = b.acquireExclusive("c1", never(), 2000);
    expect(await settledWithin(ex, 100)).toBe("pending");
    await s.release();
    const e = await ex;
    expect(e.kind).toBe("exclusive");
    expect(await redisA.get(`${SANDBOX_LOCK_PREFIX}c1`)).toBe(e.token);
    const sh = a.acquireShared("c1", 4, never(), 2000);
    expect(await settledWithin(sh, 100)).toBe("pending");
    await e.release();
    await (await sh).release();
  });

  it("intent: a waiting exclusive blocks new shared leases and gets in when running ones release", async () => {
    const a = leasesA({ pollMs: 50 });
    const b = leasesB({ pollMs: 50 });
    const s1 = await a.acquireShared("c1", 4, never(), 1000);
    const ex = b.acquireExclusive("c1", never(), 3000, { intent: true });
    await sleep(150);
    // the intent stops new shared leases
    const late = a.acquireShared("c1", 4, never(), 3000);
    expect(await settledWithin(late, 100)).toBe("pending");
    await s1.release();
    const e = await ex;
    expect(e.kind).toBe("exclusive");
    expect(await redisA.exists("capk:sandbox-intent:c1")).toBe(0);
    expect(await settledWithin(late, 50)).toBe("pending");
    await e.release();
    await (await late).release();
  });

  it("without intent a waiting exclusive does not block new shared leases", async () => {
    const a = leasesA();
    const b = leasesB();
    const s1 = await a.acquireShared("c1", 4, never(), 1000);
    const ex = b.acquireExclusive("c1", AbortSignal.timeout(300));
    await sleep(30);
    const s2 = await a.acquireShared("c1", 4, never(), 100);
    await s1.release();
    await s2.release();
    await (await ex).release();
  });

  it("downgrade lets the downgrader keep running while others join", async () => {
    const a = leasesA();
    const b = leasesB();
    const e = await a.acquireExclusive("c1", never(), 1000, { intent: true });
    expect(await b.tryExclusive("c1")).toBeNull();
    const s = await e.downgrade();
    expect(s.kind).toBe("shared");
    expect(s.token).toBe(e.token);
    expect(s.signal.aborted).toBe(false);
    await expect(e.downgrade()).rejects.toThrow(/not exclusive/);
    expect(await redisA.get(`${SANDBOX_LOCK_PREFIX}c1`)).toBe("shared");
    const other = await b.acquireShared("c1", 4, never(), 100);
    expect(await a.sharedCount("c1")).toBe(2);
    expect(await s.renew()).toBe(true);
    await expect(s.downgrade()).rejects.toThrow(/not exclusive/);
    await s.release();
    await other.release();
    expect(await a.sharedCount("c1")).toBe(0);
  });

  it("a short-TTL holder never shortens the keys a longer-TTL holder relies on", async () => {
    const long = leasesA({ ttlMs: 10_000 });
    const short = leasesB({ ttlMs: 300 });
    const l1 = await long.acquireShared("c1", 4, never(), 100);
    const l2 = await short.acquireShared("c1", 4, never(), 100);
    expect(await redisA.pttl(`capk:sandbox-users:c1`)).toBeGreaterThan(5000);
    expect(await redisA.pttl(`${SANDBOX_LOCK_PREFIX}c1`)).toBeGreaterThan(5000);
    // the short holder renews every 100 ms; its renewals do not shorten the keys either
    await sleep(500);
    expect(await redisA.pttl(`capk:sandbox-users:c1`)).toBeGreaterThan(5000);
    expect(await long.sharedCount("c1")).toBe(2);
    expect(await l1.renew()).toBe(true);
    await l1.release();
    await l2.release();
  });

  it("releasing the exclusive view after a downgrade releases the shared lease (no leak)", async () => {
    const a = leasesA();
    const e = await a.acquireExclusive("c1", never(), 1000);
    await e.downgrade();
    expect(await a.sharedCount("c1")).toBe(1);
    await e.release();
    expect(await a.sharedCount("c1")).toBe(0);
    expect(await redisA.exists(`${SANDBOX_LOCK_PREFIX}c1`)).toBe(0);
    expect(await leasesB().tryExclusive("c1")).not.toBeNull();
  });

  it("a waiter switches to a shared lease under its own intent; others' intents still block", async () => {
    const a = leasesA();
    const b = leasesB();
    const s0 = await a.acquireShared("c1", 4, never(), 100);
    const waiter = "w-token";
    expect(await a.tryExclusive("c1", { token: waiter, intent: true })).toBeNull();
    // the intent blocks other callers' shared leases ...
    expect(await b.tryShared("c1", 4)).toBeNull();
    // ... but not the waiter's own
    const mine = await a.tryShared("c1", 4, waiter);
    expect(mine).not.toBeNull();
    await a.clearIntent("c1", waiter);
    const other = await b.tryShared("c1", 4);
    expect(other).not.toBeNull();
    await Promise.all([s0.release(), mine?.release(), other?.release()]);
    expect(await a.sharedCount("c1")).toBe(0);
  });

  it("a holder that stops renewing expires; its signal aborts on the next failed renewal", async () => {
    // a crashed shared holder: a member and the shared marker written with a short expiry
    const now = Date.now();
    const [sec, usec] = await redisA.time();
    const redisNow = Number(sec) * 1000 + Math.floor(Number(usec) / 1000);
    await redisA.zadd("capk:sandbox-users:c1", redisNow + 150, "dead");
    await redisA.pexpire("capk:sandbox-users:c1", 150);
    await redisA.set(`${SANDBOX_LOCK_PREFIX}c1`, "shared", "PX", 150);
    const b = leasesB();
    expect(await b.tryExclusive("c1")).toBeNull();
    await sleep(Math.max(0, 200 - (Date.now() - now)));
    const e = await b.tryExclusive("c1");
    expect(e).not.toBeNull();
    await e?.release();

    // a live holder whose lease vanished (e.g. it paused longer than the TTL)
    const a = leasesA();
    const l = await a.acquireShared("c2", 4, never(), 1000);
    await redisA.zrem("capk:sandbox-users:c2", l.token);
    expect(await l.renew()).toBe(false);
    expect(l.signal.aborted).toBe(true);
    expect(l.signal.reason).toBeInstanceOf(SandboxLockLostError);
    await l.release();

    // the renewal timer notices too
    const short = leasesA({ ttlMs: 300 });
    const x = await short.acquireExclusive("c3", never(), 1000);
    await redisA.set(`${SANDBOX_LOCK_PREFIX}c3`, "someone-else", "PX", 5000);
    await sleep(250);
    expect(x.signal.aborted).toBe(true);
    await x.release();
    expect(await redisA.get(`${SANDBOX_LOCK_PREFIX}c3`)).toBe("someone-else");
  });

  it("renewal keeps a lease past its TTL", async () => {
    const a = leasesA({ ttlMs: 1500 });
    const s = await a.acquireShared("c1", 4, never(), 1000);
    const e = leasesB({ ttlMs: 1500 });
    await sleep(2500);
    expect(s.signal.aborted).toBe(false);
    expect(await a.sharedCount("c1")).toBe(1);
    expect(await e.tryExclusive("c1")).toBeNull();
    await s.release();
  });

  it("an old-style SET NX token on capk:sandbox key blocks shared; a shared value blocks SET NX", async () => {
    const a = leasesA();
    await redisB.set(`${SANDBOX_LOCK_PREFIX}c1`, "old-replica-token", "PX", 5000, "NX");
    const err = await a.acquireShared("c1", 4, never(), 60).catch((e: unknown) => e);
    expect((err as ApiError).code).toBe("sandbox.busy");
    expect(await a.tryExclusive("c1")).toBeNull();
    await redisB.del(`${SANDBOX_LOCK_PREFIX}c1`);

    const s = await a.acquireShared("c1", 4, never(), 100);
    expect(
      await redisB.set(`${SANDBOX_LOCK_PREFIX}c1`, "old-replica-token", "PX", 5000, "NX"),
    ).toBe(null);
    await s.release();
    expect(
      await redisB.set(`${SANDBOX_LOCK_PREFIX}c1`, "old-replica-token", "PX", 5000, "NX"),
    ).toBe("OK");
  });

  it("claimDeadHolders returns only tags without live leases, once", async () => {
    const a = leasesA();
    const b = leasesB();
    const live = await a.acquireShared("c1", 4, never(), 1000);
    await a.registerHolder("c1", live.token, 60_000);
    // a holder whose lease is gone (its replica crashed)
    await b.registerHolder("c1", "dead-1", 60_000);
    await b.registerHolder("c1", "dead-2", 60_000);
    await redisA.set(`${SANDBOX_BUSY_PREFIX}c1`, "old", "PX", 60_000);
    const first = await b.claimDeadHolders("c1");
    expect(first.tags.sort()).toEqual(["dead-1", "dead-2"]);
    // a shared acquirer never claims the legacy marker (live siblings may run)
    expect(first.legacyMarker).toBe(false);
    expect(await redisA.exists(`${SANDBOX_BUSY_PREFIX}c1`)).toBe(1);
    expect(await b.claimDeadHolders("c1")).toEqual({ tags: [], legacyMarker: false });
    expect(await redisA.hkeys("capk:sandbox-holders:c1")).toEqual([live.token]);
    await a.unregisterHolder("c1", live.token);
    expect(await redisA.hkeys("capk:sandbox-holders:c1")).toEqual([]);
    await live.release();

    // the exclusive holder's own record is live; the legacy busy marker is claimed once, and only
    // by the caller holding the exclusive lease
    const e = await b.acquireExclusive("c2", never(), 1000);
    await redisA.set(`${SANDBOX_BUSY_PREFIX}c2`, "old", "PX", 60_000);
    expect(await a.claimDeadHolders("c2", "not-the-holder")).toEqual({
      tags: [],
      legacyMarker: false,
    });
    expect(await a.claimDeadHolders("c2")).toEqual({ tags: [], legacyMarker: false });
    expect(await b.claimDeadHolders("c2", e.token)).toEqual({ tags: [], legacyMarker: true });
    expect(await b.claimDeadHolders("c2", e.token)).toEqual({ tags: [], legacyMarker: false });
    await b.registerHolder("c2", e.token, 60_000);
    await b.unregisterHolder("c2", e.token);
    await e.release();
  });

  it("new holders also write the legacy busy marker as v2: ignored by new code, kept while any holder record is", async () => {
    const a = leasesA();
    const busy = `${SANDBOX_BUSY_PREFIX}c1`;
    await a.registerHolder("c1", "h1", 120_000);
    expect(await redisA.get(busy)).toBe("v2");
    expect(await redisA.pttl(busy)).toBeGreaterThan(60_000);
    expect(await a.legacyMarker("c1")).toBe(false);
    await a.registerHolder("c1", "h2", 60_000);
    await a.unregisterHolder("c1", "h1");
    // h2's record is still there: an old replica must still see a marker
    expect(await redisA.get(busy)).toBe("v2");
    await a.unregisterHolder("c1", "h2");
    expect(await redisA.exists(busy)).toBe(0);

    // a crashed new holder leaves v2 behind: an old replica's swap sees a value and kills everything
    await a.registerHolder("c2", "crashed", 60_000);
    const swapped = await redisB.eval(
      "local o = redis.call('GET', KEYS[1]); redis.call('SET', KEYS[1], ARGV[1], 'PX', 60000); return o",
      1,
      `${SANDBOX_BUSY_PREFIX}c2`,
      "old-token",
    );
    expect(swapped).toBe("v2");
    await redisA.del(`${SANDBOX_BUSY_PREFIX}c2`);

    // the new exclusive acquirer claims the dead record; v2 is not a legacy marker, and it goes
    // with the last record
    await a.registerHolder("c3", "dead", 60_000);
    const e = await a.acquireExclusive("c3", never(), 1000);
    expect(await a.claimDeadHolders("c3", e.token)).toEqual({
      tags: ["dead"],
      legacyMarker: false,
    });
    expect(await redisA.exists(`${SANDBOX_BUSY_PREFIX}c3`)).toBe(0);
    await e.release();

    // an old holder's marker (its token) is never overwritten by v2, and never deleted by new code
    await redisA.set(`${SANDBOX_BUSY_PREFIX}c4`, "old-holder", "PX", 60_000);
    await a.registerHolder("c4", "h", 60_000);
    await a.unregisterHolder("c4", "h");
    expect(await redisA.get(`${SANDBOX_BUSY_PREFIX}c4`)).toBe("old-holder");
    expect(await a.legacyMarker("c4")).toBe(true);
  });

  it("an intent outlives a short poll interval (floor of 2 s)", async () => {
    const a = leasesA();
    const s = await a.acquireShared("c1", 4, never(), 1000);
    expect(await leasesB().tryExclusive("c1", { token: "w", intent: true })).toBeNull();
    expect(await redisA.pttl("capk:sandbox-intent:c1")).toBeGreaterThan(1500);
    await leasesB().clearIntent("c1", "w");
    await s.release();
  });

  it("a renewal counts as fresh from when it was sent, not when its reply arrived", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    try {
      // a Redis stand-in whose replies the test releases
      const replies: ((v: number) => void)[] = [];
      let immediate = true;
      const stub = {
        eval: () => (immediate ? Promise.resolve(1) : new Promise<number>((r) => replies.push(r))),
      } as unknown as Redis;
      const l = await new SandboxLeases({ redis: stub, log, ttlMs: 300 }).acquireShared(
        "c1",
        4,
        never(),
        1000,
      );
      immediate = false;
      // t=100: the renewal is sent (Redis sets expiry 400); its reply arrives at t=190
      await vi.advanceTimersByTimeAsync(100);
      expect(replies).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(90);
      replies.shift()?.(1);
      // t=200: the next renewal is sent and never answered; from the send at t=100 the lease is
      // older than 2/3 TTL (200 ms) at t=350, while counted from the reply it would not be until 390
      await vi.advanceTimersByTimeAsync(170);
      expect(l.signal.aborted).toBe(true);
      for (const r of replies) r(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a path lease that was lost aborts its signal", async () => {
    const a = leasesA({ pathTtlMs: 300 });
    const p = await a.pathLease("c1", "/workspace/a.txt", never(), 1000);
    const key = (await redisA.keys("capk:sandbox-path:*"))[0] as string;
    await redisA.set(key, "someone-else", "PX", 5000);
    await sleep(250);
    expect(p.signal.aborted).toBe(true);
    expect(p.signal.reason).toBeInstanceOf(SandboxLockLostError);
    await p.release();
    expect(await redisA.get(key)).toBe("someone-else");
  });

  it("pathLease serializes the same path, not different paths", async () => {
    const a = leasesA();
    const b = leasesB();
    const p1 = await a.pathLease("c1", "/workspace/a.txt", never(), 1000);
    const other = await b.pathLease("c1", "/workspace/b.txt", never(), 100);
    const same = b.pathLease("c1", "/workspace/a.txt", never(), 2000);
    expect(await settledWithin(same, 100)).toBe("pending");
    await p1.release();
    const p2 = await same;
    const err = await a.pathLease("c1", "/workspace/a.txt", never(), 60).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SandboxPathBusyError);
    expect((err as Error).message).toBe("another sub-agent is writing this file; try again");
    await p2.release();
    await other.release();
  });

  it("all keys carry a TTL", async () => {
    const a = leasesA();
    const b = leasesB();
    const s = await a.acquireShared("c1", 4, never(), 1000);
    await expectAllKeysExpire();
    await a.registerHolder("c1", s.token, 120_000);
    await expectAllKeysExpire();
    expect(await redisA.pttl("capk:sandbox-holders:c1")).toBeGreaterThan(60_000);
    const ex = b.acquireExclusive("c1", never(), 2000, { intent: true });
    await sleep(40);
    await expectAllKeysExpire();
    expect(await redisA.exists("capk:sandbox-intent:c1")).toBe(1);
    await s.renew();
    await expectAllKeysExpire();
    await a.unregisterHolder("c1", s.token);
    await s.release();
    const e = await ex;
    await expectAllKeysExpire();
    const d: SandboxLease = await e.downgrade();
    await expectAllKeysExpire();
    const p = await a.pathLease("c1", "/workspace/x", never(), 100);
    await expectAllKeysExpire();
    await b.claimDeadHolders("c1");
    await expectAllKeysExpire();
    await p.release();
    await d.release();
    await expectAllKeysExpire();
  });

  it("an aborted wait fails with the signal's reason and leaves no intent behind", async () => {
    const a = leasesA();
    const b = leasesB();
    const s = await a.acquireShared("c1", 4, never(), 1000);
    const ctl = new AbortController();
    const ex = b.acquireExclusive("c1", ctl.signal, 5000, { intent: true });
    await sleep(40);
    ctl.abort(new Error("stop"));
    await expect(ex).rejects.toThrow("stop");
    expect(await redisA.exists("capk:sandbox-intent:c1")).toBe(0);
    await s.release();
  });
});
