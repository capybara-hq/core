import { startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Inject, Injectable } from "@nestjs/common";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../src/errors.js";
import { generateKey } from "../../src/infra/lock/key-template.js";
import { LockService } from "../../src/infra/lock/lock.service.js";
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
