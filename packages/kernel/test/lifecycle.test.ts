import { connect, createServer, type Server, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type KernelConfig, KernelConfigSchema } from "../src/config/schema.js";
import type { KernelHttpApp } from "../src/http/app.js";
import { createKernel, type Kernel } from "../src/kernel.js";
import { createLogger, type KernelLogger } from "../src/log.js";
import { SLOW_GATES_KEY, type SlowGates } from "./fixtures/plugins/slow/index.js";
import { SSE_HOLD_KEY } from "./fixtures/plugins/sse-hold/index.js";

let pgc: TestContainer;
let rd: TestContainer;
let kernels: Kernel[] = [];
const masterKey = Buffer.alloc(32, 7).toString("base64");
const fx = (n: string) =>
  fileURLToPath(new URL(`./fixtures/plugins/${n}/index.ts`, import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const cfg = (over: Record<string, unknown> = {}): KernelConfig =>
  KernelConfigSchema.parse({
    db: { url: pgc.url, poolMax: 3 },
    redis: { url: rd.url },
    masterKey,
    marketplaces: { official: { enabled: false } },
    http: { port: 0 },
    extensionPermissions: { autoApprove: true },
    ...over,
  });

const silent = (): KernelLogger => createLogger("error", { write: () => {} });

/**
 * Creates a kernel that afterEach stops. With `signal` (the test context's, aborted when the test
 * times out): a body that is still running after its test timed out (vitest does not cancel it)
 * creates no kernel after afterEach has run, so it cannot leak connections into the next test.
 */
async function kernel(
  config: KernelConfig,
  opts?: Parameters<typeof createKernel>[1],
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const k = await createKernel(config, { env: {}, logger: silent(), ...opts });
  if (signal?.aborted) {
    await k.stop();
    signal.throwIfAborted();
  }
  kernels.push(k);
  return k;
}

/**
 * Polls until fn returns a truthy value or the timeout passes, and returns the last value. With
 * `signal`, stops polling and throws once the test has timed out.
 */
async function waitFor<T>(
  fn: () => Promise<T>,
  timeoutMs = 5_000,
  stepMs = 50,
  signal?: AbortSignal,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let v = await fn();
  while (!v && Date.now() < deadline && !signal?.aborted) {
    await sleep(stepMs);
    v = await fn();
  }
  signal?.throwIfAborted();
  return v;
}

/** 测试侧 Redis 客户端：读插件 kv、数连接。 */
function redisClient(): Redis {
  return new Redis(rd.url);
}

async function clientCount(r: Redis): Promise<number> {
  const list = (await r.call("CLIENT", "LIST")) as string;
  return list.split("\n").filter((l) => l.trim() !== "").length;
}

/** 绕过内核直接往 jobber 的队列投递任务。 */
async function enqueueJobber(data: Record<string, unknown>): Promise<void> {
  const q = new Queue("cap.jobber.job", { connection: { url: rd.url } });
  try {
    await q.add("job", data);
  } finally {
    await q.close();
  }
}

async function pgKernelConnections(): Promise<number> {
  const c = new pg.Client({ connectionString: pgc.url });
  await c.connect();
  try {
    const r = await c.query<{ n: number }>(
      "select count(*)::int as n from pg_stat_activity where application_name = 'capybara-kernel' and datname = current_database()",
    );
    return r.rows[0]?.n ?? 0;
  } finally {
    await c.end();
  }
}

/**
 * 从独立连接持有某 schema 的迁移 advisory lock，使内核迁移阻塞在取锁上；此时 stop()：
 * stop() 返回后该库不得残留 capybara-kernel 连接（迁移会话已结束），start() reject。
 */
async function stopDuringMigration(schema: string, config: KernelConfig): Promise<void> {
  const holder = new pg.Client({ connectionString: pgc.url });
  await holder.connect();
  try {
    await holder.query("select pg_advisory_lock(hashtext($1))", [`capybara-migrate:${schema}`]);
    const k = await kernel(config);
    const starting = k.start();
    starting.catch(() => {});
    const waiting = await waitFor(async () => {
      const r = await holder.query<{ n: number }>(
        "select count(*)::int as n from pg_stat_activity where application_name = 'capybara-kernel' and wait_event_type = 'Lock' and datname = current_database()",
      );
      return (r.rows[0]?.n ?? 0) > 0;
    });
    expect(waiting).toBe(true);
    await k.stop();
    expect(await waitFor(async () => (await pgKernelConnections()) === 0, 1_000, 20)).toBe(true);
    await expect(starting).rejects.toThrow();
  } finally {
    await holder.end();
  }
}

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
});
afterEach(async () => {
  const ks = kernels;
  kernels = [];
  await Promise.all(ks.map((k) => k.stop()));
});
afterAll(async () => {
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

describe("角色与 HTTP", () => {
  it("worker-only serves health only", async () => {
    const k = await kernel(cfg({ roles: ["worker"], extensions: [fx("fixture")] }));
    await k.start();
    expect(k.port).toBeGreaterThan(0);
    expect((await fetch(`http://127.0.0.1:${k.port}/healthz`)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${k.port}/readyz`)).status).toBe(200);
    expect((await k.http.inject({ method: "GET", url: "/plugins/fixture/hello" })).statusCode).toBe(
      404,
    );
  });

  it("gateway serves plugins but not api", async () => {
    const k = await kernel(cfg({ roles: ["gateway"], extensions: [fx("fixture")] }));
    await k.start();
    const r = await k.http.inject({ method: "GET", url: "/plugins/fixture/hello" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toBe("hello");
    const me = await k.http.inject({ method: "GET", url: "/api/v1/me" });
    expect(me.statusCode).toBe(404);
    expect((me.json() as { error: { code: string } }).error.code).toBe("not_found");
  });
});

describe("插件生命周期", () => {
  it("plugins close in reverse topological order", async () => {
    const lines: Record<string, unknown>[] = [];
    const logger = createLogger("info", { write: (l) => lines.push(JSON.parse(l)) });
    // 故意把 dep-b 写在前面：拓扑序仍是 dep-a → dep-b
    const k = await kernel(cfg({ extensions: [fx("dep-b"), fx("dep-a")] }), { logger });
    await k.start();
    await k.stop();
    const closed = lines.filter((l) => l.msg === "plugin closed").map((l) => l.plugin);
    expect(closed).toEqual(["dep-b", "dep-a"]);
  });

  // The waits below add up to more than vitest's 5 s default (up to 5 s for the baseline, then the
  // start, the stop and up to 1 s), so the test has its own timeout. If it still times out, the
  // signal stops the body before it creates a kernel or right after (see kernel()), so it leaks no
  // connections into the next test.
  it("stop during slow start does not leak", { timeout: 30_000 }, async ({ signal }) => {
    // A new deferred per run, handed to the fixture through a deployment config key (a rerun does
    // not reuse an old, already resolved deferred)
    const entered = deferred();
    const gate = deferred();
    const key = `run-${Date.now()}-${Math.random()}`;
    const g = globalThis as { [SLOW_GATES_KEY]?: Map<string, SlowGates> };
    g[SLOW_GATES_KEY] ??= new Map();
    g[SLOW_GATES_KEY].set(key, { entered, gate });
    const r = redisClient();
    // A timed-out body must not stay parked on the gate
    signal.addEventListener("abort", () => gate.resolve(), { once: true });
    try {
      await waitFor(async () => (await clientCount(r)) === 1, 5_000, 50, signal);
      const baseline = await clientCount(r);
      const k = await kernel(
        cfg({ extensions: [fx("slow")], extensionConfig: { slow: { key } } }),
        undefined,
        signal,
      );
      const starting = k.start();
      starting.catch(() => {});
      // 等 setup 卡在 gate 上再停机（此时 slow 的 BullMQ Worker 连接已建立）
      await entered.promise;
      await k.stop();
      // setup 仍挂在 gate 上：stop() 返回时 slow 的 BullMQ 连接必须已经关闭（连接关闭在服务端生效有微小延迟，短轮询）
      await waitFor(async () => (await clientCount(r)) === baseline, 1_000, 20);
      expect(await clientCount(r)).toBe(baseline);
      gate.resolve();
      await expect(starting).rejects.toThrow(/closed during load/);
      expect(await clientCount(r)).toBe(baseline);
    } finally {
      gate.resolve();
      g[SLOW_GATES_KEY]?.delete(key);
      r.disconnect();
    }
  });

  it("stop during kernel migration ends the migration session", async () => {
    await stopDuringMigration("capybara", cfg());
  });

  it("stop during plugin migration ends the migration session", async () => {
    await stopDuringMigration("plugin_fixture", cfg({ extensions: [fx("fixture")] }));
  });

  it("start failure releases resources", async () => {
    // 先确认正常运行的内核确实以 application_name=capybara-kernel 连接 PG（否则下面的 0 没有意义）
    const ok = await kernel(cfg());
    await ok.start();
    expect(await pgKernelConnections()).toBeGreaterThan(0);
    await ok.stop();
    expect(await waitFor(async () => (await pgKernelConnections()) === 0)).toBe(true);

    // 部署配置不合法不再让启动失败（C10：待配置）；用 setup 抛错的插件
    const k = await kernel(cfg({ extensions: [fx("throws")] }));
    await expect(k.start()).rejects.toThrow(/setup failed: boom/);
    expect(await waitFor(async () => (await pgKernelConnections()) === 0)).toBe(true);
  });

  it("ctx.db.destroy is blocked", async () => {
    const k = await kernel(cfg({ extensions: [fx("dbdestroy")] }));
    await expect(k.start()).rejects.toThrow(/not allowed/);
  });

  it.each(["transaction", "connection"])(
    "destroy on the Kysely passed to ctx.db.%s().execute(cb) is blocked",
    async (via) => {
      const k = await kernel(
        cfg({ extensions: [fx("dbdestroy-cb")], extensionConfig: { "dbdestroy-cb": { via } } }),
      );
      await expect(k.start()).rejects.toThrow(/setup failed.*not allowed/);
    },
  );

  it("relative resolveFrom", async () => {
    const k = await kernel(cfg({ extensions: ["./plugins/fixture/index.ts"] }), {
      resolveFrom: "packages/kernel/test/fixtures",
    });
    await k.start();
    expect((await k.http.inject({ method: "GET", url: "/plugins/fixture/hello" })).body).toBe(
      "hello",
    );
  });
});

describe("队列", () => {
  it("stop waits for in-flight job", async () => {
    const r = redisClient();
    try {
      const k = await kernel(cfg({ extensions: [fx("jobber")] }));
      await k.start();
      await enqueueJobber({ key: "inflight", delayMs: 800 });
      expect(await waitFor(() => r.get("cap:jobber:kv:inflight.started"))).toBe("1");
      await k.stop();
      expect(await r.get("cap:jobber:kv:inflight")).not.toBeNull();
    } finally {
      r.disconnect();
    }
  });

  it("api-only does not consume", async () => {
    const r = redisClient();
    try {
      const api = await kernel(
        cfg({
          roles: ["api"],
          extensions: [fx("jobber")],
          extensionConfig: { jobber: { replica: "api" } },
        }),
      );
      await api.start();
      await enqueueJobber({ key: "apionly" });
      // api 副本先起且一直在线：任务只能由后起的 worker 副本执行（handler 记录执行副本）
      const worker = await kernel(
        cfg({
          roles: ["worker"],
          extensions: [fx("jobber")],
          extensionConfig: { jobber: { replica: "worker" } },
        }),
      );
      await worker.start();
      const done = await waitFor(() => r.get("cap:jobber:kv:apionly"));
      expect(done).not.toBeNull();
      expect(JSON.parse(done as string).replica).toBe("worker");
    } finally {
      r.disconnect();
    }
  });
});

describe("超时", () => {
  it("pg connect timeout", async () => {
    // 只 accept 不应答的 TCP 端口：PG 客户端握手永远收不到回应
    const sockets: Socket[] = [];
    const server: Server = createServer((s) => {
      sockets.push(s);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const k = await kernel(
        cfg({ db: { url: `postgres://u:p@127.0.0.1:${port}/db`, connectTimeoutMs: 500 } }),
      );
      const t0 = Date.now();
      const outcome = await Promise.race([
        k.start().then(
          () => "resolved",
          () => "rejected",
        ),
        sleep(3_000).then(() => "timeout"),
      ]);
      expect(outcome).toBe("rejected");
      expect(Date.now() - t0).toBeLessThan(3_000);
    } finally {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("listen 卡住 + 慢 HTTP 连接：等待 listen 与关闭 HTTP 共用 10s 截止时间", async () => {
    let sock: Socket | undefined;
    try {
      const k = await kernel(cfg());
      const http = k.http as KernelHttpApp;
      const realListen = http.listen.bind(http);
      const listened = deferred<number>();
      // 真正监听后不返回：stop() 时 listen 一直「进行中」
      http.listen = async (p) => {
        listened.resolve(await realListen(p));
        return new Promise<number>(() => {});
      };
      const starting = k.start();
      starting.catch(() => {});
      const port = await listened.promise;
      // 发半个请求并保持连接：HTTP 关闭会一直等它
      sock = connect({ port, host: "127.0.0.1" });
      sock.on("error", () => {});
      await new Promise<void>((resolve) => sock?.once("connect", () => resolve()));
      sock.write("GET /healthz HTTP/1.1\r\nHost: localhost\r\n");
      const t0 = Date.now();
      await k.stop();
      const elapsed = Date.now() - t0;
      expect(elapsed).toBeLessThanOrEqual(10_500);
      expect(elapsed).toBeGreaterThanOrEqual(9_500);
    } finally {
      sock?.destroy();
    }
  }, 20_000);

  it("停机先中止进行中的插件请求：插件 SSE 收到 req.signal 中止，不占满 10s 的 http 预算", async () => {
    const g = globalThis as unknown as Record<string, number | undefined>;
    g[SSE_HOLD_KEY] = 0;
    const k = await kernel(cfg({ extensions: [fx("sse-hold")] }));
    await k.start();
    const res = await fetch(`http://127.0.0.1:${k.port}/plugins/sse-hold/hold`);
    expect(res.status).toBe(200);
    const reader = res.body?.getReader();
    await reader?.read();
    const t0 = Date.now();
    await k.stop();
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(g[SSE_HOLD_KEY]).toBe(1);
    await reader?.cancel().catch(() => {});
  }, 20_000);

  it("http phase cannot starve queue drain", async () => {
    const r = redisClient();
    let sock: Socket | undefined;
    try {
      const k = await kernel(cfg({ extensions: [fx("jobber")] }));
      await k.start();
      // 发半个请求并保持连接：HTTP 关闭会一直等它
      sock = connect({ port: k.port as number, host: "127.0.0.1" });
      sock.on("error", () => {});
      await new Promise<void>((resolve) => sock?.once("connect", () => resolve()));
      sock.write("GET /healthz HTTP/1.1\r\nHost: localhost\r\n");
      await enqueueJobber({ key: "drain", delayMs: 2_000 });
      expect(await waitFor(() => r.get("cap:jobber:kv:drain.started"))).toBe("1");
      const t0 = Date.now();
      await k.stop();
      expect(Date.now() - t0).toBeLessThan(30_000);
      expect(await r.get("cap:jobber:kv:drain")).not.toBeNull();
    } finally {
      sock?.destroy();
      r.disconnect();
    }
  }, 45_000);
});
