import { connect, createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ConfigSource } from "../src/config/load.js";
import { type KernelConfig, KernelConfigSchema } from "../src/config/schema.js";
import { createKernel, type Kernel, migrateAll } from "../src/kernel.js";
import { createLogger } from "../src/log.js";

let pgc: TestContainer;
let rd: TestContainer;
const kernels: Kernel[] = [];
const masterKey = Buffer.alloc(32, 7).toString("base64");
const fx = (n: string) =>
  fileURLToPath(new URL(`./fixtures/plugins/${n}/index.ts`, import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const raw = (over: Record<string, unknown> = {}, redisUrl = rd.url): Record<string, unknown> => ({
  db: { url: pgc.url, poolMax: 3 },
  redis: { url: redisUrl },
  masterKey,
  http: { port: 0 },
  ...over,
});
const cfg = (over: Record<string, unknown> = {}, redisUrl?: string): KernelConfig =>
  KernelConfigSchema.parse(raw(over, redisUrl));

/** 捕获日志行的 logger。 */
function capture(level = "info") {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger(level, { write: (l) => lines.push(JSON.parse(l)) });
  return { logger, lines };
}

/** 可手动推送变更的假配置来源。 */
function manualSource() {
  let push: ((raw: unknown) => void) | undefined;
  let stopped = false;
  const source: ConfigSource = {
    load: async () => ({}),
    watch(onChange) {
      push = onChange;
      return () => {
        stopped = true;
      };
    },
  };
  return {
    source,
    push: (r: unknown) => push?.(r),
    get stopped() {
      return stopped;
    },
  };
}

async function kernel(config: KernelConfig, opts?: Parameters<typeof createKernel>[1]) {
  const k = await createKernel(config, {
    env: {},
    logger: createLogger("info", { write: () => {} }),
    ...opts,
  });
  kernels.push(k);
  return k;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ port, host: "127.0.0.1" });
    sock.once("connect", () => {
      sock.destroy();
      resolve(true);
    });
    sock.once("error", () => resolve(false));
  });
}

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
});
afterAll(async () => {
  await Promise.all(kernels.map((k) => k.stop()));
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

describe("HTTP 健康检查", () => {
  it("/healthz 200；/readyz 200 且标出 pg / redis 正常，且不泄漏连接串", async () => {
    const k = await kernel(cfg());
    await k.start();
    const h = await k.http.inject({ method: "GET", url: "/healthz" });
    expect(h.statusCode).toBe(200);
    expect(h.json()).toEqual({ ok: true });
    const r = await k.http.inject({ method: "GET", url: "/readyz" });
    expect(r.statusCode).toBe(200);
    const text = r.body;
    expect(JSON.parse(text)).toMatchObject({ pg: "ok", redis: "ok" });
    expect(text).not.toContain(pgc.url);
    expect(text).not.toContain("postgres://");
    expect(text).not.toContain("redis://");
  });

  it("start 运行内核迁移（capybara schema）", async () => {
    const k = await kernel(cfg());
    await k.start();
    const c = new pg.Client({ connectionString: pgc.url });
    await c.connect();
    try {
      const r = await c.query("select name from capybara._migrations order by name");
      expect(r.rows.map((x) => x.name)).toContain("0001_init.sql");
    } finally {
      await c.end();
    }
  });

  it("关闭 Redis 容器后 /readyz 503，body 标出 redis", async () => {
    const own = await startTestRedis();
    const k = await createKernel(cfg({}, own.url), {
      env: {},
      logger: createLogger("error", { write: () => {} }),
    });
    try {
      await k.start();
      expect((await k.http.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(200);
      await own.stop();
      const r = await k.http.inject({ method: "GET", url: "/readyz" });
      expect(r.statusCode).toBe(503);
      expect(r.json()).toMatchObject({ pg: "ok", redis: "error" });
    } finally {
      await k.stop();
    }
  }, 60_000);

  it("stop() 后 /readyz 立即 503", async () => {
    const k = await kernel(cfg());
    await k.start();
    expect((await k.http.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(200);
    const stopping = k.stop();
    const r = await k.http.inject({ method: "GET", url: "/readyz" });
    expect(r.statusCode).toBe(503);
    await stopping;
    // 停机完成后 HTTP 应用已关闭，不再接受请求（进程内注入同样拒绝）
    await expect(k.http.inject({ method: "GET", url: "/readyz" })).rejects.toThrow();
    await k.stop(); // 幂等
  });
});

describe("插件路由", () => {
  it("挂在 /plugins/<name>/* 下，直接访问插件路径 404", async () => {
    const k = await kernel(cfg({ plugins: [fx("fixture")] }));
    await k.start();
    const r = await k.http.inject({ method: "GET", url: "/plugins/fixture/hello" });
    expect(r.statusCode).toBe(200);
    expect(r.body).toBe("hello");
    for (const url of ["/hello", "/plugins/fixture/nope"]) {
      const res = await k.http.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(404);
      expect((res.json() as { error: { code: string } }).error.code, url).toBe("not_found");
    }
  });
});

describe("启动日志", () => {
  it("Nest 的路由映射等日志降为 debug，不出现在 info 级", async () => {
    const { logger, lines } = capture("info");
    const k = await kernel(cfg(), { logger });
    await k.start();
    expect(lines.some((l) => l.msg === "kernel started")).toBe(true);
    expect(lines.filter((l) => String(l.msg).includes("Mapped"))).toEqual([]);
  });
});

describe("配置热更新", () => {
  it("log.level 热生效；http.port 变化不生效并 warn；非法配置保持原配置", async () => {
    const { logger, lines } = capture("info");
    const src = manualSource();
    const k = await kernel(cfg(), { source: src.source, logger });
    await k.start();
    expect(k.log.level).toBe("info");

    src.push(raw({ log: { level: "debug" } }));
    expect(k.log.level).toBe("debug");
    expect(k.config.log.level).toBe("debug");

    src.push(raw({ log: { level: "debug" }, http: { port: 9999 } }));
    expect(k.config.http.port).toBe(0);
    const warn = lines.find((l) => l.level === "warn" && JSON.stringify(l).includes("http.port"));
    expect(warn).toBeDefined();
    expect(JSON.stringify(lines)).not.toContain(pgc.url);

    const before = k.config;
    src.push({ ...raw(), masterKey: "not-a-key", log: { level: "error" } });
    expect(k.config).toEqual(before);
    expect(k.log.level).toBe("debug");
    expect(lines.some((l) => l.level === "error" && JSON.stringify(l).includes("masterKey"))).toBe(
      true,
    );

    await k.stop();
    expect(src.stopped).toBe(true);
  });
});

describe("角色", () => {
  it("roles: [worker] 时只暴露健康端点（不转发插件路由），队列 handler 能执行", async () => {
    const port = await freePort();
    const k = await kernel(cfg({ roles: ["worker"], http: { port }, plugins: [fx("jobber")] }));
    await k.start();
    expect(k.port).toBe(port);
    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${port}/plugins/jobber/x`)).status).toBe(404);
    const r = new Redis(rd.url);
    try {
      let done: string | null = null;
      for (let i = 0; i < 50 && done === null; i++) {
        done = await r.get("cap:jobber:kv:done");
        if (done === null) await sleep(100);
      }
      expect(done).toBe(JSON.stringify({ n: 1, replica: null }));
    } finally {
      r.disconnect();
    }
  });

  it("roles 含 api 时监听端口", async () => {
    const k = await kernel(cfg({ roles: ["api"] }));
    await k.start();
    const port = k.port as number;
    expect(port).toBeGreaterThan(0);
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.status).toBe(200);
    await k.stop();
    expect(k.port).toBeUndefined();
    expect(await canConnect(port)).toBe(false);
  });
});

describe("migrateAll", () => {
  it("跑内核与已配置插件的迁移，不调用 setup", async () => {
    // throws 的 setup 会抛错：若 migrateAll 调用了 setup，这里就会失败
    const r = await migrateAll(cfg({ plugins: [fx("fixture"), fx("throws")] }));
    expect(r.map((x) => x.schema)).toEqual(["capybara", "plugin_fixture"]);
    const c = new pg.Client({ connectionString: pgc.url });
    await c.connect();
    try {
      const n = await c.query("select count(*)::int as n from plugin_fixture._migrations");
      expect(n.rows[0].n).toBe(1);
    } finally {
      await c.end();
    }
  });
});
