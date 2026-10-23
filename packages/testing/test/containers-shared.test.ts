import { Redis } from "ioredis";
import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startRedisContainer, withStartSlot } from "../src/containers.js";
import setup from "../src/global-setup.js";
import {
  createFreshDatabase,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "../src/index.js";

// Runs under the root vitest config, whose node project registers the globalSetup
// (packages/testing/src/global-setup.ts) that starts one PostgreSQL and one Valkey per run.

const started: TestContainer[] = [];
const track = (c: TestContainer) => {
  started.push(c);
  return c;
};

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(started.splice(0).map((c) => c.stop()));
});

const adminUrl = () => process.env.CAPYBARA_TEST_PG_ADMIN_URL as string;
const dbName = (url: string) => new URL(url).pathname.slice(1);
const hostPort = (url: string) => new URL(url).host;

async function databaseExists(name: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: adminUrl() });
  await client.connect();
  try {
    const r = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
    return r.rowCount === 1;
  } finally {
    await client.end();
  }
}

async function onRedis<T>(url: string, fn: (r: Redis) => Promise<T>): Promise<T> {
  const r = new Redis(url);
  try {
    return await fn(r);
  } finally {
    r.disconnect();
  }
}

// With CAPYBARA_TEST_NO_SHARED=1 the globalSetup starts nothing, so there is nothing shared to test.
describe.skipIf(process.env.CAPYBARA_TEST_NO_SHARED === "1")("container start slots", () => {
  const KEY = "capybara-test:container-starts";
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("never runs more starts at once than CAPYBARA_TEST_CONTAINER_STARTS", async () => {
    // A key of its own: other files of the run take real slots on the shared key meanwhile.
    vi.stubEnv("CAPYBARA_TEST_CONTAINER_STARTS", "2");
    let running = 0;
    let peak = 0;
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        withStartSlot(async () => {
          running++;
          peak = Math.max(peak, running);
          await sleep(150);
          running--;
          return i;
        }, `${KEY}-test-${process.pid}`),
      ),
    );
    expect(results).toEqual([0, 1, 2, 3, 4, 5]);
    expect(peak).toBe(2);
  });

  it("reclaims a slot left behind by a crashed worker, and releases its own on failure", async () => {
    vi.stubEnv("CAPYBARA_TEST_CONTAINER_STARTS", "1");
    const key = `${KEY}-stale-${process.pid}`;
    const url = process.env.CAPYBARA_TEST_REDIS_URL as string;
    await onRedis(url, (r) => r.zadd(key, Date.now() - 10 * 60_000, "crashed"));
    await expect(
      withStartSlot(async () => {
        throw new Error("start failed");
      }, key),
    ).rejects.toThrow("start failed");
    expect(await onRedis(url, (r) => r.zcard(key))).toBe(0);
    expect(await withStartSlot(async () => "ok", key)).toBe("ok");
  });
});

describe.skipIf(process.env.CAPYBARA_TEST_NO_SHARED === "1")("shared test containers", () => {
  it("the globalSetup addresses reach the worker through process.env", () => {
    expect(process.env.CAPYBARA_TEST_PG_ADMIN_URL).toMatch(/^postgres(ql)?:\/\//);
    expect(process.env.CAPYBARA_TEST_REDIS_URL).toMatch(/^redis:\/\//);
  });

  it("startTestPostgres gives each caller its own database on the shared server; stop drops it", async () => {
    const a = track(await startTestPostgres());
    const b = track(await startTestPostgres());
    expect(hostPort(a.url)).toBe(hostPort(adminUrl()));
    expect(hostPort(b.url)).toBe(hostPort(adminUrl()));
    expect(dbName(a.url)).not.toBe(dbName(b.url));
    expect(dbName(a.url)).not.toBe(dbName(adminUrl()));

    // The database is usable and empty of anything the other caller writes.
    const client = new pg.Client({ connectionString: a.url });
    await client.connect();
    await client.query("CREATE TABLE only_in_a (x int)");
    await client.end();
    const other = new pg.Client({ connectionString: b.url });
    await other.connect();
    const r = await other.query("SELECT to_regclass('only_in_a') AS t");
    await other.end();
    expect(r.rows[0].t).toBeNull();

    expect(await databaseExists(dbName(a.url))).toBe(true);
    await a.stop();
    expect(await databaseExists(dbName(a.url))).toBe(false);
    // stop is idempotent
    await a.stop();
  });

  it("createFreshDatabase creates a random database and drops it even with open connections", async () => {
    const db = await createFreshDatabase(adminUrl());
    const client = new pg.Client({ connectionString: db.url });
    await client.connect();
    client.on("error", () => {});
    expect(await databaseExists(dbName(db.url))).toBe(true);
    await db.drop();
    expect(await databaseExists(dbName(db.url))).toBe(false);
    await client.end().catch(() => {});
  });

  it("startTestRedis({ shared: true }) hands out distinct databases of the shared instance; stop flushes", async () => {
    const a = track(await startTestRedis({ shared: true }));
    const b = track(await startTestRedis({ shared: true }));
    const shared = process.env.CAPYBARA_TEST_REDIS_URL as string;
    expect(hostPort(a.url)).toBe(hostPort(shared));
    expect(hostPort(b.url)).toBe(hostPort(shared));
    const dbA = Number(dbName(a.url));
    const dbB = Number(dbName(b.url));
    expect(dbA).toBeGreaterThan(0);
    expect(dbB).toBeGreaterThan(0);
    expect(dbA).not.toBe(dbB);

    await onRedis(a.url, (r) => r.set("k", "a"));
    expect(await onRedis(b.url, (r) => r.get("k"))).toBeNull();
    await a.stop();
    expect(await onRedis(a.url, (r) => r.dbsize())).toBe(0);
  });

  it("startTestRedis() without shared starts a container of its own", async () => {
    const own = track(await startTestRedis());
    expect(hostPort(own.url)).not.toBe(hostPort(process.env.CAPYBARA_TEST_REDIS_URL as string));
    expect(await onRedis(own.url, (r) => r.ping())).toBe("PONG");
  });

  it("CAPYBARA_TEST_NO_SHARED=1 turns sharing off", async () => {
    vi.stubEnv("CAPYBARA_TEST_NO_SHARED", "1");
    const own = track(await startTestRedis({ shared: true }));
    expect(hostPort(own.url)).not.toBe(hostPort(process.env.CAPYBARA_TEST_REDIS_URL as string));
  });

  it("with an external Redis the globalSetup wraps the allocator on its CONFIG GET databases", async () => {
    const external = track(await startRedisContainer({ databases: 3 }));
    vi.stubEnv("CAPYBARA_TEST_REDIS_URL", external.url);
    const teardown = await setup();
    try {
      expect(process.env.CAPYBARA_TEST_REDIS_DATABASES).toBe("3");
      const dbs: number[] = [];
      for (let i = 0; i < 3; i++) {
        const c = await startTestRedis({ shared: true });
        expect(hostPort(c.url)).toBe(hostPort(external.url));
        dbs.push(Number(dbName(c.url)));
        await c.stop();
      }
      // DB 0 holds the counter; files get 1..databases-1 and wrap.
      expect(dbs).toEqual([1, 2, 1]);
    } finally {
      await teardown();
    }
    expect(process.env.CAPYBARA_TEST_REDIS_DATABASES).toBeUndefined();
    // The external Redis is not ours: teardown leaves it running.
    expect(await onRedis(external.url, (r) => r.ping())).toBe("PONG");
  });
});
