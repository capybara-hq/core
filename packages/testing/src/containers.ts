import { randomBytes } from "node:crypto";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Redis } from "ioredis";
import pg from "pg";
import { GenericContainer, Wait } from "testcontainers";

/** 测试容器句柄：连接串与停止函数。 */
export interface TestContainer {
  url: string;
  stop(): Promise<void>;
}

/** Admin URL of the run-wide PostgreSQL started by the vitest globalSetup (see `global-setup.ts`). */
export const PG_ADMIN_URL_ENV = "CAPYBARA_TEST_PG_ADMIN_URL";
/** URL of the run-wide Valkey started by the vitest globalSetup. */
export const REDIS_URL_ENV = "CAPYBARA_TEST_REDIS_URL";
/** Set to `1` to turn sharing off: every caller starts its own containers (for debugging). */
export const NO_SHARED_ENV = "CAPYBARA_TEST_NO_SHARED";
/** Logical databases of the shared Valkey: DB 0 holds the allocation counter, callers get 1..1023. */
export const SHARED_REDIS_DATABASES = 1024;
/**
 * Number of logical databases of the shared Redis, set by the globalSetup (read with
 * `CONFIG GET databases` when the Redis was provided externally). Unset = {@link SHARED_REDIS_DATABASES}.
 */
export const REDIS_DATABASES_ENV = "CAPYBARA_TEST_REDIS_DATABASES";
/** Counter key (in DB 0 of the shared Valkey) that hands out database numbers. */
const REDIS_DB_COUNTER = "capybara-test:db";

/** True when `CAPYBARA_TEST_NO_SHARED=1`. */
export function sharingDisabled(): boolean {
  return process.env[NO_SHARED_ENV] === "1";
}

/** The shared PostgreSQL admin URL, or undefined when not running under the globalSetup / sharing is off. */
export function sharedPgAdminUrl(): string | undefined {
  return sharingDisabled() ? undefined : process.env[PG_ADMIN_URL_ENV] || undefined;
}

/** The shared Valkey URL, or undefined when not running under the globalSetup / sharing is off. */
export function sharedRedisUrl(): string | undefined {
  return sharingDisabled() ? undefined : process.env[REDIS_URL_ENV] || undefined;
}

/**
 * Concurrent container starts allowed across all workers of a run (env
 * `CAPYBARA_TEST_CONTAINER_STARTS`, default {@link DEFAULT_CONTAINER_STARTS}).
 */
export const CONTAINER_STARTS_ENV = "CAPYBARA_TEST_CONTAINER_STARTS";
export const DEFAULT_CONTAINER_STARTS = 4;
/** Sorted set (DB 0 of the shared Valkey) of the start slots in use, scored by acquisition time. */
const START_SLOTS_KEY = "capybara-test:container-starts";
/** A slot older than this is taken to belong to a crashed worker and is reclaimed. */
const START_SLOT_TTL_MS = 120_000;
const START_SLOT_POLL_MS = 100;

const ACQUIRE_SLOT = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', tonumber(ARGV[1]) - tonumber(ARGV[2]))
if redis.call('ZCARD', KEYS[1]) < tonumber(ARGV[3]) then
  redis.call('ZADD', KEYS[1], ARGV[1], ARGV[4])
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  return 1
end
return 0`;

/**
 * Run `start` (a container start) while holding one of the run-wide start slots. Under a full
 * parallel run every file starting its own Valkey at once overloads the Docker daemon, and
 * testcontainers' fixed 30 s wait for the port binding times out. Limiting how many containers start
 * at the same time keeps each start fast; the wait for a slot is plain queueing, not a retry. Without
 * the globalSetup's Valkey (sharing disabled, or the globalSetup's own starts) it starts directly.
 * `key` is the slot set (tests use their own).
 */
export async function withStartSlot<T>(
  start: () => Promise<T>,
  key: string = START_SLOTS_KEY,
): Promise<T> {
  const url = sharingDisabled() ? undefined : process.env[REDIS_URL_ENV] || undefined;
  if (url === undefined) return start();
  const limit = Number(process.env[CONTAINER_STARTS_ENV]) || DEFAULT_CONTAINER_STARTS;
  const token = `${process.pid}-${randomBytes(6).toString("hex")}`;
  const r = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 });
  await r.connect();
  try {
    for (;;) {
      const got = await r.eval(ACQUIRE_SLOT, 1, key, Date.now(), START_SLOT_TTL_MS, limit, token);
      if (got === 1) break;
      await new Promise((resolve) => setTimeout(resolve, START_SLOT_POLL_MS));
    }
    try {
      return await start();
    } finally {
      await r.zrem(key, token);
    }
  } finally {
    r.disconnect();
  }
}

/**
 * Start a throwaway PostgreSQL 17 container. `tuned` is for the run-wide shared instance: many files
 * connect at once (raise `max_connections`), and durability is irrelevant for tests (no fsync).
 */
export async function startPostgresContainer(
  opts: { tuned?: boolean } = {},
): Promise<TestContainer> {
  const image = new PostgreSqlContainer("postgres:17");
  if (opts.tuned) {
    image.withCommand([
      "postgres",
      "-c",
      "max_connections=2000",
      "-c",
      "fsync=off",
      "-c",
      "synchronous_commit=off",
      "-c",
      "full_page_writes=off",
    ]);
  }
  const container = await withStartSlot(() => image.start());
  return {
    url: container.getConnectionUri(),
    stop: async () => {
      await container.stop();
    },
  };
}

/** Start a throwaway Valkey 8 container, returning `redis://host:port`. */
export async function startRedisContainer(
  opts: { databases?: number } = {},
): Promise<TestContainer> {
  const image = new GenericContainer("valkey/valkey:8")
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage("Ready to accept connections"));
  if (opts.databases !== undefined) {
    image.withCommand(["valkey-server", "--databases", String(opts.databases)]);
  }
  const container = await withStartSlot(() => image.start());
  return {
    url: `redis://${container.getHost()}:${container.getMappedPort(6379)}`,
    stop: async () => {
      await container.stop();
    },
  };
}

/**
 * Create a randomly named database on the server behind `adminUrl` (a connection that may
 * `CREATE DATABASE`); `drop()` removes it with `DROP DATABASE … WITH (FORCE)`.
 */
export async function createFreshDatabase(
  adminUrl: string,
): Promise<{ url: string; drop(): Promise<void> }> {
  const name = `cap_${randomBytes(6).toString("hex")}`;
  const admin = async (sql: string) => {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      await client.query(sql);
    } finally {
      await client.end();
    }
  };
  await admin(`CREATE DATABASE ${name}`);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    drop: () => admin(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`),
  };
}

/**
 * A PostgreSQL for one test file. Under the vitest globalSetup (shared mode) this is a fresh random
 * database on the run-wide server and `stop()` drops it; otherwise (no globalSetup, or
 * `CAPYBARA_TEST_NO_SHARED=1`) it starts a dedicated PostgreSQL 17 container and `stop()` stops it.
 * Either way the URL points at an empty database the caller owns.
 */
export async function startTestPostgres(): Promise<TestContainer> {
  const adminUrl = sharedPgAdminUrl();
  if (adminUrl === undefined) return startPostgresContainer();
  const db = await createFreshDatabase(adminUrl);
  let stopped: Promise<void> | undefined;
  return {
    url: db.url,
    stop: () => {
      stopped ??= db.drop();
      return stopped;
    },
  };
}

/**
 * A Redis (Valkey 8) for one test file, `redis://host:port[/db]`.
 *
 * By default it starts a dedicated container: bus channels (`cap:<namespace>:<topic>`) ignore the
 * database number, so files that subscribe to the bus (anything that boots a kernel) must not share
 * an instance. `{ shared: true }` is opt-in for callers that never subscribe to pub/sub: under the
 * globalSetup it hands out a free logical database of the run-wide Valkey (`stop()` = `FLUSHDB`);
 * without one it falls back to a dedicated container.
 */
export async function startTestRedis(opts: { shared?: boolean } = {}): Promise<TestContainer> {
  const sharedUrl = opts.shared ? sharedRedisUrl() : undefined;
  if (sharedUrl === undefined) return startRedisContainer();
  const databases = Number(process.env[REDIS_DATABASES_ENV]) || SHARED_REDIS_DATABASES;
  const n = await withRedis(sharedUrl, (r) => r.incr(REDIS_DB_COUNTER));
  // Wrap around over 1..databases-1 (DB 0 holds the counter). The FLUSHDB below can only hit a file
  // that is still using the database after more than databases-1 allocations in one run (1023 with
  // the default container); a run makes about 15, so a reused database is long released.
  const db = 1 + ((n - 1) % (databases - 1));
  const url = new URL(sharedUrl);
  url.pathname = `/${db}`;
  const dbUrl = url.toString();
  // Start clean even if the counter wrapped around onto a database used earlier in the run.
  await withRedis(dbUrl, (r) => r.flushdb());
  let stopped: Promise<void> | undefined;
  return {
    url: dbUrl,
    stop: () => {
      stopped ??= withRedis(dbUrl, (r) => r.flushdb()).then(() => undefined);
      return stopped;
    },
  };
}

/** Run one command batch on a short-lived connection. */
export async function withRedis<T>(url: string, fn: (r: Redis) => Promise<T>): Promise<T> {
  const r = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 });
  try {
    await r.connect();
    return await fn(r);
  } finally {
    r.disconnect();
  }
}

/**
 * S3 兼容存储的测试镜像：官方 SeaweedFS（`chrislusf/seaweedfs`，Apache-2.0），按标签加摘要固定。
 * 它的 S3 网关会校验 POST 策略的 `content-length-range`、`eq $Content-Type` 与 `key` 条件。
 * 可用环境变量 `CAPYBARA_TEST_S3_IMAGE` 换成私有镜像源。
 */
export const TEST_S3_IMAGE =
  process.env.CAPYBARA_TEST_S3_IMAGE ||
  "chrislusf/seaweedfs:4.48@sha256:4e61d15fd35994cb1e43e1e553dff106794841fd9a99ade2fc8c8bfce4d7872d";

/** {@link startTestS3} 的句柄：S3 端点、凭据与已建好的桶。 */
export interface TestS3 {
  /** `http://host:port`（S3 API；用路径风格访问）。 */
  endpoint: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
  region: string;
  stop(): Promise<void>;
}

/** 建桶时等待 S3 网关连上 filer 的上限。 */
const S3_READY_TIMEOUT_MS = 60_000;

/**
 * 启动一个临时 SeaweedFS（`weed server -s3`，单容器含 master / volume / filer / S3 网关），
 * 启用带凭据的 S3 鉴权，经 S3 API 建好桶 `capybara`，返回端点、凭据与停止函数。
 */
export async function startTestS3(): Promise<TestS3> {
  const accessKey = "capybara-test";
  const secretKey = "capybara-test-secret";
  const bucket = "capybara";
  const region = "us-east-1";
  const s3Config = JSON.stringify({
    identities: [
      {
        name: "admin",
        credentials: [{ accessKey, secretKey }],
        actions: ["Admin", "Read", "List", "Tagging", "Write"],
      },
    ],
  });
  const image = new GenericContainer(TEST_S3_IMAGE)
    .withCopyContentToContainer([{ content: s3Config, target: "/etc/seaweedfs/s3.json" }])
    .withCommand(["server", "-s3", "-s3.config=/etc/seaweedfs/s3.json", "-dir=/data"])
    .withExposedPorts(8333)
    .withWaitStrategy(Wait.forLogMessage(/Starting S3 API Server/));
  const container = await withStartSlot(() => image.start());
  const endpoint = `http://${container.getHost()}:${container.getMappedPort(8333)}`;
  const client = new S3Client({
    endpoint,
    region,
    forcePathStyle: true,
    credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
  });
  try {
    // 网关先于 filer 就绪：建桶失败时重试，直到超时
    const deadline = Date.now() + S3_READY_TIMEOUT_MS;
    for (;;) {
      try {
        await client.send(new CreateBucketCommand({ Bucket: bucket }));
        break;
      } catch (e) {
        if (Date.now() > deadline) throw e;
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  } catch (e) {
    await container.stop();
    throw e;
  } finally {
    client.destroy();
  }
  return {
    endpoint,
    accessKey,
    secretKey,
    bucket,
    region,
    stop: async () => {
      await container.stop();
    },
  };
}
