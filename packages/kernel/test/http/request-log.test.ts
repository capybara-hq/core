import { afterEach, describe, expect, it } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";
import type { KernelHttpApp } from "../../src/http/app.js";
import { createLogger } from "../../src/log.js";
import {
  logContext,
  setJobWrapper,
  setTraceContextSource,
  withJobContext,
  withLogContext,
} from "../../src/log-context.js";
import { testHttpApp } from "../helpers/http-app.js";

const apps: KernelHttpApp[] = [];

async function app(pg: () => Promise<void> = async () => {}) {
  const lines: string[] = [];
  const log = createLogger("debug", { write: (l) => lines.push(l) });
  const a = await testHttpApp({ log, checks: { pg, redis: async () => {} }, servePlugins: true });
  apps.push(a);
  a.mountPlugins([
    {
      method: "GET",
      path: "/plugins/p/hello",
      handler: async () => {
        log.info("inside handler");
        return Response.json({ ok: true });
      },
    },
    {
      method: "GET",
      path: "/plugins/p/stream",
      handler: async () =>
        new Response("data: hi\n\n", { headers: { "content-type": "text/event-stream" } }),
    },
  ]);
  const records = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  return { a, records };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

describe("request ids and the access log", () => {
  it("assigns an id, echoes it, and puts it on records logged while handling", async () => {
    const { a, records } = await app();
    const res = await a.inject({ method: "GET", url: "/plugins/p/hello?secret=1" });
    const reqId = res.headers["x-request-id"];
    expect(reqId).toMatch(/^[A-Za-z0-9._-]{1,128}$/);
    const inside = records().find((r) => r.msg === "inside handler");
    expect(inside?.reqId).toBe(reqId);
    const access = records().filter((r) => r.msg === "request");
    expect(access).toHaveLength(1);
    expect(access[0]).toMatchObject({
      level: "info",
      method: "GET",
      url: "/plugins/p/hello",
      status: 200,
      reqId,
    });
    expect(typeof access[0]?.ms).toBe("number");
  });

  it("records logged by a Nest controller carry the request id", async () => {
    const { a, records } = await app(async () => {
      throw new Error("pg down");
    });
    const res = await a.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    const warn = records().find((r) => r.msg === "readiness check failed");
    expect(warn?.reqId).toBe(res.headers["x-request-id"]);
  });

  it("keeps a valid incoming x-request-id and replaces an invalid one", async () => {
    const { a } = await app();
    const ok = await a.inject({
      method: "GET",
      url: "/plugins/p/hello",
      headers: { "x-request-id": "abc.DEF_1-2" },
    });
    expect(ok.headers["x-request-id"]).toBe("abc.DEF_1-2");
    for (const bad of ["has space", "x".repeat(129), "semi;colon"]) {
      const res = await a.inject({
        method: "GET",
        url: "/plugins/p/hello",
        headers: { "x-request-id": bad },
      });
      expect(res.headers["x-request-id"]).not.toBe(bad);
      expect(res.headers["x-request-id"]).toMatch(/^[A-Za-z0-9._-]{1,128}$/);
    }
  });

  it("no access line for /healthz and /readyz; SSE at debug", async () => {
    const { a, records } = await app();
    await a.inject({ method: "GET", url: "/healthz" });
    await a.inject({ method: "GET", url: "/readyz" });
    expect(records().filter((r) => r.msg === "request")).toEqual([]);
    await a.inject({ method: "GET", url: "/plugins/p/stream" });
    const sse = records().filter((r) => r.msg === "request");
    expect(sse).toHaveLength(1);
    expect(sse[0]).toMatchObject({ level: "debug", url: "/plugins/p/stream" });
  });

  it("access lines redact tokens in paths", async () => {
    const { a, records } = await app();
    await a.inject({ method: "GET", url: "/api/v1/invitations/secret-token" });
    const line = records().find((r) => r.msg === "request");
    expect(line?.url).toBe("/api/v1/invitations/:token");
  });
});

describe("log context", () => {
  it("nests, and a job context carries queue / jobId / runId", async () => {
    const lines: string[] = [];
    const log = createLogger("info", { write: (l) => lines.push(l) });
    await withLogContext({ reqId: "r1" }, async () => {
      await withJobContext("cap-kernel-runs", { id: "j1", data: { runId: "run1" } }, async () => {
        await Promise.resolve();
        log.info("in job");
        expect(logContext()).toEqual({
          reqId: "r1",
          queue: "cap-kernel-runs",
          jobId: "j1",
          runId: "run1",
        });
      });
    });
    log.info("outside");
    const [inJob, outside] = lines.map((l) => JSON.parse(l));
    expect(inJob).toMatchObject({ reqId: "r1", jobId: "j1", runId: "run1" });
    expect(outside).not.toHaveProperty("reqId");
  });

  it("a registered job wrapper runs around the job inside its context; trace fields join", async () => {
    const seen: string[] = [];
    setJobWrapper(async (queue, job, fn) => {
      seen.push(`${queue}:${job.id}:${logContext()?.jobId}`);
      return fn();
    });
    setTraceContextSource(() => ({ traceId: "t1", spanId: "s1" }));
    try {
      const lines: string[] = [];
      const log = createLogger("info", { write: (l) => lines.push(l) });
      const out = await withJobContext("q", { id: "7", data: {} }, async () => {
        log.info("in");
        return 42;
      });
      expect(out).toBe(42);
      expect(seen).toEqual(["q:7:7"]);
      expect(JSON.parse(lines[0] as string)).toMatchObject({
        jobId: "7",
        traceId: "t1",
        spanId: "s1",
      });
    } finally {
      setJobWrapper(undefined);
      setTraceContextSource(undefined);
    }
  });
});

describe("http.replicaId → x-capybara-replica 响应头", () => {
  async function replicaApp(replicaId?: string): Promise<KernelHttpApp> {
    const log = createLogger("error", { write: () => {} });
    const a = await testHttpApp({
      log,
      servePlugins: true,
      ...(replicaId !== undefined && { replicaId }),
    });
    apps.push(a);
    return a;
  }

  it("设置时每个响应（健康检查、404、插件路由）都带该头", async () => {
    const a = await replicaApp("r-1");
    a.mountPlugins([
      { method: "GET", path: "/plugins/p/x", handler: async () => Response.json({ ok: true }) },
    ]);
    for (const url of ["/healthz", "/nope", "/plugins/p/x"]) {
      const r = await a.inject({ method: "GET", url });
      expect(r.headers["x-capybara-replica"], url).toBe("r-1");
    }
  });

  it("未设置时不带该头", async () => {
    const a = await replicaApp();
    const r = await a.inject({ method: "GET", url: "/healthz" });
    expect(r.headers["x-capybara-replica"]).toBeUndefined();
  });

  it("配置：可选；只允许短的安全字符", () => {
    const base = {
      db: { url: "postgres://x" },
      redis: { url: "redis://x" },
      masterKey: Buffer.alloc(32).toString("base64"),
    };
    expect(KernelConfigSchema.parse(base).http.replicaId).toBeUndefined();
    expect(KernelConfigSchema.parse({ ...base, http: { replicaId: "0" } }).http.replicaId).toBe(
      "0",
    );
    // CAPYBARA_HTTP__REPLICA_ID=0 经 JSON 解析成数字
    expect(KernelConfigSchema.parse({ ...base, http: { replicaId: 0 } }).http.replicaId).toBe(0);
    expect(() => KernelConfigSchema.parse({ ...base, http: { replicaId: "a\r\nb" } })).toThrow();
    expect(() => KernelConfigSchema.parse({ ...base, http: { replicaId: "" } })).toThrow();
  });
});
