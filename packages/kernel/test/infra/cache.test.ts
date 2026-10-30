import { startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Inject, Injectable } from "@nestjs/common";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CacheService } from "../../src/infra/cache/cache.service.js";
import { Cacheable, CacheEvict } from "../../src/infra/cache/cacheable.decorator.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import { generateKey } from "../../src/infra/lock/key-template.js";
import { createLogger, type KernelLogger } from "../../src/log.js";

let rd: TestContainer;
let redis: Redis;
beforeAll(async () => {
  rd = await startTestRedis();
  redis = new Redis(rd.url);
}, 120_000);
afterAll(async () => {
  redis?.disconnect();
  await rd?.stop();
}, 120_000);

let n = 0;
const id = () => `c${++n}-${Math.random().toString(36).slice(2)}`;

function makeLog() {
  const log = createLogger("error") as KernelLogger;
  const warn = vi.spyOn(log, "warn");
  const error = vi.spyOn(log, "error");
  return { log, warn, error };
}

@Injectable()
class Repo {
  calls = 0;
  constructor(@Inject(CacheService) readonly cacheService: CacheService) {}

  @Cacheable({ key: "repo:get:#{0}", ttl: 60 })
  async get(key: string): Promise<{ key: string } | null> {
    this.calls++;
    return key.startsWith("missing") ? null : { key };
  }

  @Cacheable({ key: "repo:nullable:#{0}", ttl: 60, cacheNull: true })
  async nullable(key: string): Promise<{ key: string } | null> {
    this.calls++;
    return key.startsWith("missing") ? null : { key };
  }

  @Cacheable({ key: "repo:big:#{0}" })
  async big(_k: string): Promise<unknown> {
    this.calls++;
    return { n: 10n };
  }

  @Cacheable({ key: "repo:undef:#{0}", cacheNull: true })
  async undef(_k: string): Promise<undefined> {
    this.calls++;
    return undefined;
  }

  @CacheEvict({ key: "repo:get:#{0}" })
  async update(key: string, fail = false): Promise<string> {
    if (fail) throw new Error("boom");
    return key;
  }

  @CacheEvict({ keys: ["repo:get:#{result.id}", "repo:get:#{0.name}"] })
  async create(input: { name: string }): Promise<{ id: string }> {
    return { id: `${input.name}-id` };
  }
}

/** A transaction host on a stub pool: `run` opens a transaction context without a database. */
function stubTxHost(): TransactionHost {
  const pool = {
    transaction: () => ({ execute: (fn: (t: unknown) => Promise<unknown>) => fn({}) }),
  };
  return new TransactionHost(pool as never, createLogger("error", { write: () => {} }));
}

describe("cache decorators inside a transaction", () => {
  it("@Cacheable neither reads nor writes the cache inside a transaction", async () => {
    const repo = new Repo(new CacheService(redis, makeLog().log));
    const k = id();
    await redis.set(`cache:repo:get:${k}`, JSON.stringify({ key: "stale" }));
    // the transaction may have written what the method reads: no cached value, nothing stored
    expect(await stubTxHost().run(() => repo.get(k))).toEqual({ key: k });
    expect(repo.calls).toBe(1);
    await redis.del(`cache:repo:get:${k}`);
    await stubTxHost().run(() => repo.get(k));
    expect(await redis.exists(`cache:repo:get:${k}`)).toBe(0);
    expect(repo.calls).toBe(2);
  });

  it("@CacheEvict inside a transaction evicts after the commit, not on rollback", async () => {
    const repo = new Repo(new CacheService(redis, makeLog().log));
    const k = id();
    await redis.set(`cache:repo:get:${k}`, "{}");
    await stubTxHost().run(async () => {
      await repo.update(k);
      // not before COMMIT: a reader could cache the old row again before it commits
      expect(await redis.exists(`cache:repo:get:${k}`)).toBe(1);
    });
    expect(await redis.exists(`cache:repo:get:${k}`)).toBe(0);
    await redis.set(`cache:repo:get:${k}`, "{}");
    await expect(
      stubTxHost().run(async () => {
        await repo.update(k);
        throw new Error("rolled back");
      }),
    ).rejects.toThrow("rolled back");
    expect(await redis.exists(`cache:repo:get:${k}`)).toBe(1);
  });
});

describe("generateKey with a result", () => {
  it("expands #{result} and #{result.path} only when a result is given", () => {
    expect(generateKey("k:#{result.id}", [], { result: { id: 9 } })).toBe("k:9");
    expect(generateKey("k:#{result}", [], { result: "r" })).toBe("k:r");
    expect(generateKey("k:#{result.id}", [{}])).toBe("k:#{result.id}");
  });
});

describe("@Cacheable", () => {
  it("misses, stores under cache:<key> with a TTL, then hits without calling the method", async () => {
    const repo = new Repo(new CacheService(redis, makeLog().log));
    const k = id();
    expect(await repo.get(k)).toEqual({ key: k });
    expect(repo.calls).toBe(1);
    const ttl = await redis.ttl(`cache:repo:get:${k}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
    expect(await repo.get(k)).toEqual({ key: k });
    expect(repo.calls).toBe(1);
  });

  it("does not cache null by default", async () => {
    const repo = new Repo(new CacheService(redis, makeLog().log));
    const k = `missing-${id()}`;
    expect(await repo.get(k)).toBeNull();
    expect(await redis.exists(`cache:repo:get:${k}`)).toBe(0);
    await repo.get(k);
    expect(repo.calls).toBe(2);
  });

  it("caches null as a sentinel when cacheNull is set", async () => {
    const repo = new Repo(new CacheService(redis, makeLog().log));
    const k = `missing-${id()}`;
    expect(await repo.nullable(k)).toBeNull();
    expect(await redis.get(`cache:repo:nullable:${k}`)).toBe("__CACHE_NULL__");
    expect(await repo.nullable(k)).toBeNull();
    expect(repo.calls).toBe(1);
  });

  it("calls the method and warns (no throw, no error) when Redis is down", async () => {
    const dead = new Redis({
      port: 1,
      lazyConnect: true,
      retryStrategy: () => null,
      maxRetriesPerRequest: 0,
    });
    dead.on("error", () => {});
    const { log, warn, error } = makeLog();
    const repo = new Repo(new CacheService(dead, log));
    expect(await repo.get("x")).toEqual({ key: "x" });
    expect(repo.calls).toBe(1);
    expect(warn).toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    dead.disconnect();
  });

  it("returns the result and warns when it cannot be serialized", async () => {
    const { log, warn, error } = makeLog();
    const repo = new Repo(new CacheService(redis, log));
    const k = id();
    expect(await repo.big(k)).toEqual({ n: 10n });
    expect(warn).toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(await redis.exists(`cache:repo:big:${k}`)).toBe(0);
  });

  it("returns null on both miss and hit for an undefined result with cacheNull", async () => {
    const repo = new Repo(new CacheService(redis, makeLog().log));
    const k = id();
    expect(await repo.undef(k)).toBeNull();
    expect(await repo.undef(k)).toBeNull();
    expect(repo.calls).toBe(1);
  });

  it("fails loudly when the class does not inject cacheService", async () => {
    class Bad {
      @Cacheable({ key: "bad:#{0}" })
      async f(_a: string) {
        return 1;
      }
    }
    await expect(new Bad().f("a")).rejects.toThrow(/cacheService/);
  });
});

describe("@CacheEvict", () => {
  it("evicts the key after the method succeeded", async () => {
    const repo = new Repo(new CacheService(redis, makeLog().log));
    const k = id();
    await repo.get(k);
    expect(await redis.exists(`cache:repo:get:${k}`)).toBe(1);
    expect(await repo.update(k)).toBe(k);
    expect(await redis.exists(`cache:repo:get:${k}`)).toBe(0);
  });

  it("does not evict when the method throws", async () => {
    const repo = new Repo(new CacheService(redis, makeLog().log));
    const k = id();
    await repo.get(k);
    await expect(repo.update(k, true)).rejects.toThrow("boom");
    expect(await redis.exists(`cache:repo:get:${k}`)).toBe(1);
  });

  it("evicts several keys, reading #{result.*} from the return value", async () => {
    const repo = new Repo(new CacheService(redis, makeLog().log));
    const name = id();
    await redis.set(`cache:repo:get:${name}-id`, "1");
    await redis.set(`cache:repo:get:${name}`, "1");
    await repo.create({ name });
    expect(await redis.exists(`cache:repo:get:${name}-id`, `cache:repo:get:${name}`)).toBe(0);
  });

  it("returns the result and only warns when Redis is down", async () => {
    const dead = new Redis({
      port: 1,
      lazyConnect: true,
      retryStrategy: () => null,
      maxRetriesPerRequest: 0,
    });
    dead.on("error", () => {});
    const { log, warn, error } = makeLog();
    const repo = new Repo(new CacheService(dead, log));
    expect(await repo.update("x")).toBe("x");
    expect(warn).toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    dead.disconnect();
  });
});
