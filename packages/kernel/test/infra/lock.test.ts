import { startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Inject, Injectable } from "@nestjs/common";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../src/errors.js";
import { generateKey } from "../../src/infra/lock/key-template.js";
import { LockService } from "../../src/infra/lock/lock.service.js";
import { DOWNGRADE_SHARED_LEASE, RENEW_SHARED_LEASE } from "../../src/infra/lock/shared-lease.js";
import { WithLock } from "../../src/infra/lock/with-lock.decorator.js";
import { createLogger } from "../../src/log.js";

let rd: TestContainer;
let r1: Redis;
let r2: Redis;
beforeAll(async () => {
  rd = await startTestRedis();
  r1 = new Redis(rd.url);
  r2 = new Redis(rd.url);
}, 120_000);
afterAll(async () => {
  r1?.disconnect();
  r2?.disconnect();
  await rd?.stop();
}, 120_000);

const log = createLogger("error");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await sleep(10);
  }
}
let n = 0;
const k = (name: string) => `${name}-${++n}-${Math.random().toString(36).slice(2)}`;

describe("generateKey", () => {
  it("expands #{0}, #{1.a}, #{id} and leaves unknown placeholders", () => {
    expect(generateKey("u:#{0}:#{1}", ["a", 7])).toBe("u:a:7");
    expect(generateKey("o:#{1.a.b}", [0, { a: { b: "x" } }])).toBe("o:x");
    expect(generateKey("o:#{id}", [{ id: 42 }])).toBe("o:42");
    expect(generateKey("o:#{0.id}", [{ id: 42 }])).toBe("o:42");
    expect(generateKey("o:#{id}:#{5}", [{}])).toBe("o:#{id}:#{5}");
  });
});

describe("LockService", () => {
  it("excludes across two Redis clients; releases for the next holder", async () => {
    const a = new LockService(r1, log);
    const b = new LockService(r2, log);
    const key = k("mx");
    const h = await a.acquire(key, { ttlMs: 5000 });
    expect(h).toBeDefined();
    expect(await b.acquire(key, { ttlMs: 5000 })).toBeUndefined();
    await h?.release();
    await h?.release(); // idempotent
    const h2 = await b.acquire(key, { ttlMs: 5000 });
    expect(h2).toBeDefined();
    await h2?.release();
  });

  it("waitMs waits for a release", async () => {
    const a = new LockService(r1, log);
    const b = new LockService(r2, log);
    const key = k("wait");
    const h = await a.acquire(key, { ttlMs: 5000 });
    setTimeout(() => void h?.release(), 100);
    const h2 = await b.acquire(key, { ttlMs: 5000, waitMs: 2000, retryMs: 20 });
    expect(h2).toBeDefined();
    await h2?.release();
  });

  it("waitMs Infinity waits until the holder releases; signal aborts the wait", async () => {
    const a = new LockService(r1, log);
    const b = new LockService(r2, log);
    const key = k("inf");
    const h = await a.acquire(key, { ttlMs: 5000 });
    const waiting = b.acquire(key, { ttlMs: 5000, waitMs: Number.POSITIVE_INFINITY, retryMs: 20 });
    await sleep(300);
    await h?.release();
    const h2 = await waiting;
    expect(h2).toBeDefined();
    const ac = new AbortController();
    const blocked = a.acquire(key, {
      ttlMs: 5000,
      waitMs: Number.POSITIVE_INFINITY,
      retryMs: 20,
      signal: ac.signal,
    });
    await sleep(100);
    const t0 = Date.now();
    ac.abort(new Error("stop waiting"));
    await expect(blocked).rejects.toThrow("stop waiting");
    expect(Date.now() - t0).toBeLessThan(500);
    await h2?.release();
    // an already aborted signal throws before trying
    await expect(
      a.acquire(k("pre"), { ttlMs: 5000, signal: AbortSignal.abort(new Error("pre")) }),
    ).rejects.toThrow("pre");
  });

  it("renews past the TTL while held", async () => {
    const a = new LockService(r1, log);
    const key = k("renew");
    const ttlMs = 600;
    const h = await a.acquire(key, { ttlMs });
    // Observe the key for 2.5 TTLs; poll fast so a slow event loop cannot hide an expiry.
    const end = Date.now() + ttlMs * 2.5;
    while (Date.now() < end) {
      expect(await r2.exists(`lock:${key}`)).toBe(1);
      await sleep(25);
    }
    expect(h?.lost.aborted).toBe(false);
    await h?.release();
    expect(await r2.exists(`lock:${key}`)).toBe(0);
  });

  it("rounds a fractional TTL up for SET and lease", async () => {
    const a = new LockService(r1, log);
    const key = k("frac");
    const h = await a.acquire(key, { ttlMs: 1500.4 });
    expect(h).toBeDefined();
    await h?.release();
    expect(await a.lease(k("frac-lease"), "x", 1500.4)).toBe(true);
  });

  it("lost fires before expiry when renewal keeps erroring", async () => {
    const lg = createLogger("debug");
    const broken = new Redis(rd.url);
    const a = new LockService(broken, lg);
    const key = k("renew-err");
    const ttlMs = 600;
    const h = await a.acquire(key, { ttlMs });
    expect(h).toBeDefined();
    const t0 = Date.now();
    vi.spyOn(broken, "eval").mockRejectedValue(new Error("redis down"));
    await until(() => h?.lost.aborted === true, 3000);
    // aborted while the key was still ours (before TTL expiry), so no one else could hold it yet
    expect(Date.now() - t0).toBeLessThan(ttlMs);
    expect(await r2.exists(`lock:${key}`)).toBe(1);
    await h?.release();
    broken.disconnect();
  });

  it("a renewal error that lands after release logs nothing", async () => {
    const lg = createLogger("debug");
    const warn = vi.spyOn(lg, "warn");
    const slow = new Redis(rd.url);
    let reject: ((e: Error) => void) | undefined;
    const a = new LockService(slow, lg);
    const h = await a.acquire(k("renew-late"), { ttlMs: 300 });
    vi.spyOn(slow, "eval").mockImplementation(
      () =>
        new Promise((_, rej) => {
          reject = rej;
        }) as never,
    );
    await until(() => reject !== undefined);
    warn.mockClear();
    vi.mocked(slow.eval).mockResolvedValue(1 as never);
    await h?.release();
    reject?.(new Error("late"));
    await sleep(50);
    expect(warn).not.toHaveBeenCalled();
    slow.disconnect();
  });

  it("a crashed holder's lock expires within the TTL (no renewal)", async () => {
    const key = k("crash");
    // a holder that never renews: the raw primitive stands in for a dead process
    expect(await new LockService(r1, log).lease(`lock:${key}`, "dead", 200)).toBe(true);
    const b = new LockService(r2, log);
    expect(await b.acquire(key, { ttlMs: 1000 })).toBeUndefined();
    const h = await b.acquire(key, { ttlMs: 1000, waitMs: 2000, retryMs: 20 });
    expect(h).toBeDefined();
    await h?.release();
  });

  it("lost fires when the key is deleted externally, and stops renewing", async () => {
    const a = new LockService(r1, log);
    const key = k("lost");
    const h = await a.acquire(key, { ttlMs: 150 });
    await r2.del(`lock:${key}`);
    await until(() => h?.lost.aborted === true);
    // a new holder is not disturbed by the old handle
    const b = new LockService(r2, log);
    const h2 = await b.acquire(key, { ttlMs: 5000 });
    await h?.release();
    expect(await r2.exists(`lock:${key}`)).toBe(1);
    await h2?.release();
  });

  it("run throws lock.acquire_failed with the key, and releases after fn", async () => {
    const a = new LockService(r1, log);
    const key = k("run");
    const err = await a
      .run(key, { ttlMs: 5000 }, async () => {
        return await a.run(key, { ttlMs: 5000 }, async () => 1).catch((e) => e);
      })
      .then((x) => x);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("lock.acquire_failed");
    expect((err as ApiError).status).toBe(409);
    expect((err as ApiError).details).toEqual([{ lockKey: `lock:${key}` }]);
    expect(await r2.exists(`lock:${key}`)).toBe(0);
  });

  it("contention is logged at info, not error", async () => {
    const lg = createLogger("debug");
    const info = vi.spyOn(lg, "info");
    const error = vi.spyOn(lg, "error");
    const a = new LockService(r1, lg);
    const key = k("log");
    const h = await a.acquire(key, { ttlMs: 5000 });
    await a.acquire(key, { ttlMs: 5000 });
    expect(info).toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    await h?.release();
  });

  it("lease / renew / releaseIf compare the holder", async () => {
    const s = new LockService(r1, log);
    const key = k("lease");
    expect(await s.lease(key, "a", 5000)).toBe(true);
    expect(await s.lease(key, "b", 5000)).toBe(false);
    expect(await s.renew(key, "b", 5000)).toBe(false);
    expect(await s.renew(key, "a", 60_000)).toBe(true);
    expect(await r1.pttl(key)).toBeGreaterThan(10_000);
    expect(await s.releaseIf(key, "b")).toBe(false);
    expect(await s.releaseIf(key, "a")).toBe(true);
    expect(await r1.exists(key)).toBe(0);
  });
});

@Injectable()
class Svc {
  constructor(
    @Inject(LockService) readonly lockService: LockService,
    readonly counter: { active: number; maxActive: number } = { active: 0, maxActive: 0 },
  ) {}

  @WithLock({ key: "svc:#{0}:#{1.id}", ttl: 5000, waitTimeout: 0 })
  async tryOnce(_a: string, _b: { id: number }, hold: Promise<void>) {
    await hold;
    return "done";
  }

  @WithLock({ key: "svc:wait:#{0}", ttl: 5000, waitTimeout: 3000, retryInterval: 20 })
  async serial(_id: string) {
    this.counter.active++;
    this.counter.maxActive = Math.max(this.counter.maxActive, this.counter.active);
    await sleep(50);
    this.counter.active--;
  }
}

describe("LockService.keepAlive: loss is a deadline (R19)", () => {
  // TTL 300 -> renewal every 100; deadline = send time of the last successful renewal + 200
  const TTL = 300;
  const quiet = createLogger("error", { write: () => {} });
  type Next = "ok" | "fail" | "hang";
  function start(plan: () => Next) {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
      now: 0,
    });
    const renew = vi.fn(async () => {
      const next = plan();
      if (next === "ok") return true;
      if (next === "fail") throw new Error("redis down");
      return new Promise<boolean>(() => {});
    });
    const h = new LockService(r1, quiet).keepAlive("lease", TTL, {
      renew,
      release: async () => {},
    });
    return { h, renew };
  }
  const at = (ms: number) => vi.advanceTimersByTimeAsync(ms - Date.now());

  it("(a) a renewal just after a watchdog tick, then fast failures: lost at its send time + ttl - interval", async () => {
    let mode: Next = "ok";
    const { h } = start(() => mode);
    await at(100); // the watchdog's renewal (sent at 100) succeeds
    await at(105);
    // an out-of-phase renewal (e.g. the supervisor's heartbeat), sent at 105, succeeds
    expect(await h.renew()).toBe(true);
    mode = "fail"; // then Redis rejects at once
    await at(304);
    expect(h.lost.aborted).toBe(false);
    await at(305);
    // 200 after that renewal was sent: one full interval before the key could expire (405)
    expect(h.lost.aborted).toBe(true);
    await h.release();
    vi.useRealTimers();
  });

  it("(b) a renewal that hangs: lost on time, with the renewal still in flight", async () => {
    const { h, renew } = start(() => "hang");
    await at(199);
    expect(renew).toHaveBeenCalled();
    expect(h.lost.aborted).toBe(false);
    await at(200);
    expect(h.lost.aborted).toBe(true);
    await h.release();
    vi.useRealTimers();
  });

  it("(c) a successful explicit renew() moves the deadline", async () => {
    let mode: Next = "fail";
    const { h } = start(() => mode);
    await at(150);
    mode = "ok";
    expect(await h.renew()).toBe(true); // sent at 150
    mode = "fail";
    await at(349);
    expect(h.lost.aborted).toBe(false);
    await at(350);
    expect(h.lost.aborted).toBe(true);
    await h.release();
    vi.useRealTimers();
  });

  it("a renewal answered false loses the lease at once", async () => {
    let ok = true;
    const quietLock = new LockService(r1, quiet);
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
      now: 0,
    });
    const h = quietLock.keepAlive("lease", TTL, { renew: async () => ok, release: async () => {} });
    ok = false;
    await vi.advanceTimersByTimeAsync(100);
    expect(h.lost.aborted).toBe(true);
    await h.release();
    vi.useRealTimers();
  });

  it("a renewal answered false after abandon() logs nothing and loses nothing", async () => {
    const lines: string[] = [];
    const lock = new LockService(r1, createLogger("warn", { write: (l) => lines.push(l) }));
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
      now: 0,
    });
    let answer: (ok: boolean) => void = () => {};
    const h = lock.keepAlive("lease", TTL, {
      renew: () => new Promise<boolean>((r) => (answer = r)),
      release: async () => {},
    });
    await vi.advanceTimersByTimeAsync(100); // the watchdog's renewal is in flight
    h.abandon();
    answer(false); // the key was taken meanwhile: nobody holds this lease any more
    await vi.advanceTimersByTimeAsync(1_000);
    expect(lines).toEqual([]);
    expect(h.lost.aborted).toBe(false);
    vi.useRealTimers();
  });
});

describe("LockService shared leases (Task 3.8)", () => {
  const keysOf = (name: string) => {
    const id = k(name);
    return { lock: `${id}:lock`, users: `${id}:users`, intent: `${id}:intent` };
  };

  it("up to cap shared holders across two clients; exclusive only when none is left", async () => {
    const a = new LockService(r1, log);
    const b = new LockService(r2, log);
    const keys = keysOf("rw");
    const s1 = await a.tryShared(keys, "s1", 2, 5000);
    const s2 = await b.tryShared(keys, "s2", 2, 5000);
    expect(s1?.kind).toBe("shared");
    expect(s2).toBeDefined();
    expect(await a.tryShared(keys, "s3", 2, 5000)).toBeUndefined();
    expect(await b.sharedCount(keys)).toBe(2);
    expect(await r1.get(keys.lock)).toBe("shared");
    expect(await b.tryExclusive(keys, "x", 5000)).toBeUndefined();
    await s1?.release();
    await s2?.release();
    expect(await a.sharedCount(keys)).toBe(0);
    expect(await r1.exists(keys.lock)).toBe(0);
    const x = await b.tryExclusive(keys, "x", 5000);
    expect(x?.kind).toBe("exclusive");
    expect(await r1.get(keys.lock)).toBe("x");
    expect(await a.tryShared(keys, "s4", 2, 5000)).toBeUndefined();
    await x?.release();
  });

  it("intent: a failed exclusive try with an intent blocks other tokens' shared leases, not its own", async () => {
    const a = new LockService(r1, log);
    const b = new LockService(r2, log);
    const keys = keysOf("intent");
    const s = await a.tryShared(keys, "s", 4, 5000);
    expect(await b.tryExclusive(keys, "w", 5000, 2000)).toBeUndefined();
    expect(await r1.get(keys.intent)).toBe("w");
    expect(await a.tryShared(keys, "other", 4, 5000)).toBeUndefined();
    const own = await b.tryShared(keys, "w", 4, 5000);
    expect(own).toBeDefined();
    await own?.release();
    await s?.release();
    // a successful exclusive try clears its own intent
    const x = await b.tryExclusive(keys, "w", 5000, 2000);
    expect(x).toBeDefined();
    expect(await r1.exists(keys.intent)).toBe(0);
    await x?.release();
  });

  it("a crashed shared holder's lease expires within the TTL (no renewal)", async () => {
    const a = new LockService(r1, log);
    const keys = keysOf("crash");
    const s = await a.tryShared(keys, "crashed", 4, 300);
    // stops renewing without releasing: the holder "crashed"
    s?.abandon();
    const b = new LockService(r2, log);
    expect(await b.tryExclusive(keys, "x", 5000)).toBeUndefined();
    await sleep(400);
    const x = await b.tryExclusive(keys, "x", 5000);
    expect(x).toBeDefined();
    await x?.release();
  });

  it("fencing: a holder whose key was taken loses its lease (renew false, lost aborts) and its release leaves the new holder alone", async () => {
    const a = new LockService(r1, log);
    const keys = keysOf("fence");
    const x = await a.tryExclusive(keys, "old", 5000);
    await r2.set(keys.lock, "new", "PX", 5000);
    expect(await x?.renew()).toBe(false);
    expect(x?.lost.aborted).toBe(true);
    await x?.release();
    expect(await r1.get(keys.lock)).toBe("new");

    // a shared holder whose lock key now holds an exclusive token is out
    const sk = keysOf("fence-s");
    const s = await a.tryShared(sk, "s", 4, 5000);
    await r2.set(sk.lock, "intruder", "PX", 5000);
    expect(await s?.renew()).toBe(false);
    expect(s?.lost.aborted).toBe(true);
    expect(await r1.zscore(sk.users, "s")).toBeNull();
    await s?.release();
    expect(await r1.get(sk.lock)).toBe("intruder");
  });

  it("downgrade: exclusive → shared with the same token; others join; downgrade twice throws", async () => {
    const a = new LockService(r1, log);
    const b = new LockService(r2, log);
    const keys = keysOf("down");
    const x = await a.tryExclusive(keys, "t", 5000);
    expect(await x?.downgrade()).toBe(true);
    expect(x?.kind).toBe("shared");
    expect(x?.token).toBe("t");
    await expect(x?.downgrade()).rejects.toThrow(/not exclusive/);
    expect(await r1.get(keys.lock)).toBe("shared");
    const other = await b.tryShared(keys, "o", 4, 5000);
    expect(await a.sharedCount(keys)).toBe(2);
    expect(await x?.renew()).toBe(true);
    await x?.release();
    await other?.release();
    expect(await a.sharedCount(keys)).toBe(0);
  });

  it("a downgrade of a lost exclusive lease answers false and loses it", async () => {
    const a = new LockService(r1, log);
    const keys = keysOf("down-lost");
    const x = await a.tryExclusive(keys, "t", 5000);
    await r1.del(keys.lock);
    expect(await x?.downgrade()).toBe(false);
    expect(x?.lost.aborted).toBe(true);
    await x?.release();
  });

  it("a downgrade answered after the lease was lost still releases the shared member (no leak)", async () => {
    // TTL 3000 -> deadline 2000 after the acquire; the renewals hang, the downgrade runs in Redis
    // at once but its reply arrives at ~2300, after the lease was lost
    const proxied = new Proxy(r1, {
      get(t, p) {
        if (p === "eval") {
          return async (script: string, ...args: unknown[]) => {
            if (script === RENEW_SHARED_LEASE) return new Promise(() => {});
            // biome-ignore lint/suspicious/noExplicitAny: forwards the call unchanged
            const r = await (t.eval as any)(script, ...args);
            if (script === DOWNGRADE_SHARED_LEASE) await sleep(2300);
            return r;
          };
        }
        const v = Reflect.get(t, p);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    const a = new LockService(proxied, createLogger("error", { write: () => {} }));
    const keys = keysOf("down-late");
    const x = await a.tryExclusive(keys, "t", 3000);
    expect(await x?.downgrade()).toBe(false);
    expect(x?.lost.aborted).toBe(true);
    await x?.release();
    expect(await r1.zscore(keys.users, "t")).toBeNull();
    expect(await new LockService(r1, log).sharedCount(keys)).toBe(0);
  });

  it("a renewal sent while a downgrade is in flight renews the lease as shared (no spurious loss)", async () => {
    // TTL 1500 -> a renewal every 500, deadline 1000 after the acquire; the downgrade runs in
    // Redis at once and its reply takes 700 ms, so the renewal at 500 is due while the handle still
    // says exclusive
    const proxied = new Proxy(r1, {
      get(t, p) {
        if (p === "eval") {
          return async (script: string, ...args: unknown[]) => {
            // biome-ignore lint/suspicious/noExplicitAny: forwards the call unchanged
            const r = await (t.eval as any)(script, ...args);
            if (script === DOWNGRADE_SHARED_LEASE) await sleep(700);
            return r;
          };
        }
        const v = Reflect.get(t, p);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    const a = new LockService(proxied, createLogger("error", { write: () => {} }));
    const keys = keysOf("down-race");
    const x = await a.tryExclusive(keys, "t", 1500);
    expect(await x?.downgrade()).toBe(true);
    await sleep(1200);
    expect(x?.lost.aborted).toBe(false);
    expect(await new LockService(r1, log).sharedCount(keys)).toBe(1);
    await x?.release();
  });

  it("a successful downgrade moves the R19 deadline (fake timers)", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
      now: 0,
    });
    try {
      // TTL 300 -> renewal every 100; deadline = send time of the last success + 200
      const stub = {
        eval: async (script: string) => {
          if (script === RENEW_SHARED_LEASE) throw new Error("redis down");
          return 1;
        },
      } as unknown as Redis;
      const a = new LockService(stub, createLogger("error", { write: () => {} }));
      const x = await a.tryExclusive(keysOf("down-deadline"), "t", 300);
      await vi.advanceTimersByTimeAsync(50);
      expect(await x?.downgrade()).toBe(true); // sent at 50
      await vi.advanceTimersByTimeAsync(249 - Date.now());
      // without the move the lease would be lost at 200
      expect(x?.lost.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(250 - Date.now());
      expect(x?.lost.aborted).toBe(true);
      await x?.release();
    } finally {
      vi.useRealTimers();
    }
  });

  it("renewal keeps a shared lease past its TTL", async () => {
    const a = new LockService(r1, log);
    const keys = keysOf("renew");
    const s = await a.tryShared(keys, "s", 4, 300);
    await sleep(700);
    expect(s?.lost.aborted).toBe(false);
    expect(await a.sharedCount(keys)).toBe(1);
    await s?.release();
  });
});

describe("@WithLock", () => {
  it("holds the expanded key during the call and throws lock.acquire_failed when busy", async () => {
    const svc = new Svc(new LockService(r1, log));
    const other = new Svc(new LockService(r2, log));
    let open!: () => void;
    const gate = new Promise<void>((r) => {
      open = r;
    });
    const first = svc.tryOnce("a", { id: 3 }, gate);
    await until(async () => (await r2.exists("lock:svc:a:3")) === 1);
    const err = await other.tryOnce("a", { id: 3 }, Promise.resolve()).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("lock.acquire_failed");
    expect((err as ApiError).details).toEqual([{ lockKey: "lock:svc:a:3" }]);
    open();
    expect(await first).toBe("done");
    expect(await r2.exists("lock:svc:a:3")).toBe(0);
  });

  it("serializes callers that wait", async () => {
    const shared = { active: 0, maxActive: 0 };
    const svc = new Svc(new LockService(r1, log), shared);
    const other = new Svc(new LockService(r2, log), shared);
    const id = k("s");
    await Promise.all([svc.serial(id), other.serial(id), svc.serial(id)]);
    expect(shared.maxActive).toBe(1);
  });

  it("fails loudly without an injected lockService", async () => {
    class Bad {
      @WithLock({ key: "x" })
      async m() {}
    }
    await expect(new Bad().m()).rejects.toThrow(/lockService/);
  });
});
