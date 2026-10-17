import { connect, createServer, type Server, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type KernelConfig, KernelConfigSchema } from "../src/config/schema.js";
import { createKernel, type Kernel } from "../src/kernel.js";
import { createLogger, type KernelLogger } from "../src/log.js";

let pgc: TestContainer;
let rd: TestContainer;
let kernels: Kernel[] = [];
const masterKey = Buffer.alloc(32, 7).toString("base64");
const fx = (n: string) =>
  fileURLToPath(new URL(`./fixtures/plugins/${n}/index.ts`, import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const cfg = (over: Record<string, unknown> = {}): KernelConfig =>
  KernelConfigSchema.parse({
    db: { url: pgc.url, poolMax: 3 },
    redis: { url: rd.url },
    masterKey,
    http: { port: 0 },
    ...over,
  });

const silent = (): KernelLogger => createLogger("error", { write: () => {} });

async function kernel(config: KernelConfig, opts?: Parameters<typeof createKernel>[1]) {
  const k = await createKernel(config, { env: {}, logger: silent(), ...opts });
  kernels.push(k);
  return k;
}

/** 轮询直到 fn 返回 truthy 或超时；返回最后一次的值。 */
async function waitFor<T>(fn: () => Promise<T>, timeoutMs = 5_000, stepMs = 50): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let v = await fn();
  while (!v && Date.now() < deadline) {
    await sleep(stepMs);
    v = await fn();
  }
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
      "select count(*)::int as n from pg_stat_activity where application_name = 'capybara-kernel'",
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
        "select count(*)::int as n from pg_stat_activity where application_name = 'capybara-kernel' and wait_event_type = 'Lock'",
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
    const k = await kernel(cfg({ roles: ["worker"], plugins: [fx("fixture")] }));
    await k.start();
    expect(k.port).toBeGreaterThan(0);
    expect((await fetch(`http://127.0.0.1:${k.port}/healthz`)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${k.port}/readyz`)).status).toBe(200);
    expect((await k.http.inject({ method: "GET", url: "/plugins/fixture/hello" })).statusCode).toBe(
      404,
    );
  });

  it("gateway serves plugins but not api", async () => {
    const k = await kernel(cfg({ roles: ["gateway"], plugins: [fx("fixture")] }));
    await k.start();
    const r = await k.http.inject({ method: "GET", url: "/plugins/fixture/hello" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toBe("hello");
  });
});

describe("插件生命周期", () => {
  it("plugins close in reverse topological order", async () => {
    const lines: Record<string, unknown>[] = [];
    const logger = createLogger("info", { write: (l) => lines.push(JSON.parse(l)) });
    // 故意把 dep-b 写在前面：拓扑序仍是 dep-a → dep-b
    const k = await kernel(cfg({ plugins: [fx("dep-b"), fx("dep-a")] }), { logger });
    await k.start();
    await k.stop();
    const closed = lines.filter((l) => l.msg === "plugin closed").map((l) => l.plugin);
    expect(closed).toEqual(["dep-b", "dep-a"]);
  });

  it("stop during slow start does not leak", async () => {
    const slow = (await import(fx("slow"))) as {
      entered: { promise: Promise<void> };
      gate: { resolve: () => void };
    };
    const r = redisClient();
    try {
      await waitFor(async () => (await clientCount(r)) === 1, 5_000);
      const baseline = await clientCount(r);
      const k = await kernel(cfg({ plugins: [fx("slow")] }));
      const starting = k.start();
      starting.catch(() => {});
      // 等 setup 卡在 gate 上再停机（此时 slow 的 BullMQ Worker 连接已建立）
      await slow.entered.promise;
      await k.stop();
      // setup 仍挂在 gate 上：stop() 返回时 slow 的 BullMQ 连接必须已经关闭（连接关闭在服务端生效有微小延迟，短轮询）
      await waitFor(async () => (await clientCount(r)) === baseline, 1_000, 20);
      expect(await clientCount(r)).toBe(baseline);
      slow.gate.resolve();
      await expect(starting).rejects.toThrow(/closed during load/);
      expect(await clientCount(r)).toBe(baseline);
    } finally {
      r.disconnect();
    }
  });

  it("stop during kernel migration ends the migration session", async () => {
    await stopDuringMigration("capybara", cfg());
  });

  it("stop during plugin migration ends the migration session", async () => {
    await stopDuringMigration("plugin_fixture", cfg({ plugins: [fx("fixture")] }));
  });

  it("start failure releases resources", async () => {
    // 先确认正常运行的内核确实以 application_name=capybara-kernel 连接 PG（否则下面的 0 没有意义）
    const ok = await kernel(cfg());
    await ok.start();
    expect(await pgKernelConnections()).toBeGreaterThan(0);
    await ok.stop();
    expect(await waitFor(async () => (await pgKernelConnections()) === 0)).toBe(true);

    const k = await kernel(cfg({ plugins: [fx("badconfig")] }));
    await expect(k.start()).rejects.toThrow(/invalid deployment config/);
    expect(await waitFor(async () => (await pgKernelConnections()) === 0)).toBe(true);
  });

  it("ctx.db.destroy is blocked", async () => {
    const k = await kernel(cfg({ plugins: [fx("dbdestroy")] }));
    await expect(k.start()).rejects.toThrow(/not allowed/);
  });

  it("relative resolveFrom", async () => {
    const k = await kernel(cfg({ plugins: ["./plugins/fixture/index.ts"] }), {
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
      const k = await kernel(cfg({ plugins: [fx("jobber")] }));
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
      const api = await kernel(cfg({ roles: ["api"], plugins: [fx("jobber")] }));
      await api.start();
      await enqueueJobber({ key: "apionly" });
      await sleep(1_000);
      expect(await r.get("cap:jobber:kv:apionly")).toBeNull();
      const worker = await kernel(cfg({ roles: ["worker"], plugins: [fx("jobber")] }));
      await worker.start();
      expect(await waitFor(() => r.get("cap:jobber:kv:apionly"))).not.toBeNull();
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

  it("http phase cannot starve queue drain", async () => {
    const r = redisClient();
    let sock: Socket | undefined;
    try {
      const k = await kernel(cfg({ plugins: [fx("jobber")] }));
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
