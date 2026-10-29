import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { Redis } from "ioredis";
import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { closeKernelApp, createKernelApp, startKernelApp } from "../../src/app.js";
import { kernelDb } from "../../src/db/kernel-schema.js";
import { GracefulShutdown } from "../../src/infra/lifecycle/graceful-shutdown.service.js";
import { KernelLifecycle } from "../../src/lifecycle/kernel-lifecycle.js";
import { createLogger } from "../../src/log.js";
import { GatewayRole } from "../../src/roles/gateway-role.js";
import { SLOW_GATES_KEY, type SlowGates } from "../fixtures/plugins/slow/index.js";
import { asUser, cookieJar } from "../helpers/http.js";
import { accountsFor } from "../helpers/identity.js";
import {
  createAgent,
  createConv,
  createOrg,
  eventsOf,
  PW,
  postMessage,
  runConfig,
  runsOf,
  waitFor,
} from "../helpers/runs.js";

/**
 * Graceful shutdown through the signal handlers of `startKernelApp` (nest kernel spec §4): a
 * signal during the start aborts it and closes cleanly; a signal while a conversation runs drains
 * it within the stop budgets; a second signal exits at once; event streams opened once the
 * shutdown began end at once.
 */

let pgc: TestContainer;
let rd: TestContainer;
/** The test's own pool, under another application_name than the kernel's (counted below). */
// biome-ignore lint/suspicious/noExplicitAny: untyped test pool
let raw: Kysely<any>;
const apps: NestFastifyApplication[] = [];
const SLOW = fileURLToPath(new URL("../fixtures/plugins/slow/index.ts", import.meta.url));
const silent = () => createLogger("error", { write: () => {} });

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A signal source and an exit recorder in place of the process. */
function fakeProcess() {
  const signals = new EventEmitter();
  const exits: number[] = [];
  const exited = deferred<number>();
  return {
    signals,
    exits,
    exited: exited.promise,
    exit: (code: number) => {
      exits.push(code);
      exited.resolve(code);
    },
  };
}

async function redisClients(): Promise<number> {
  const r = new Redis(rd.url);
  try {
    const list = (await r.call("CLIENT", "LIST")) as string;
    return list.split("\n").filter((l) => l.trim() !== "").length - 1;
  } finally {
    r.disconnect();
  }
}

async function kernelPgConnections(): Promise<number> {
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

async function eventually(fn: () => Promise<boolean>, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 20));
  }
}

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = new Kysely({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString: pgc.url, max: 3, application_name: "test" }),
    }),
  });
}, 120_000);
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => closeKernelApp(a)));
});
afterAll(async () => {
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

describe("startKernelApp signal handling", () => {
  it("SIGTERM during the start aborts it, closes Redis and the pool, exits 0; a second SIGTERM exits 1 at once", async () => {
    const baseline = await redisClients();
    const key = `run-${Date.now()}-${Math.random()}`;
    const entered = deferred();
    const gate = deferred();
    const g = globalThis as { [SLOW_GATES_KEY]?: Map<string, SlowGates> };
    g[SLOW_GATES_KEY] ??= new Map();
    g[SLOW_GATES_KEY].set(key, { entered, gate });
    const p = fakeProcess();
    try {
      const starting = startKernelApp(
        runConfig(
          { pg: pgc.url, redis: rd.url },
          { extensions: [SLOW], extensionConfig: { slow: { key } } },
        ),
        { env: {}, logger: silent() },
        { signals: p.signals, exit: p.exit },
      );
      starting.catch(() => {});
      // The extension setup hangs on its gate: the start sequence is in the extension load
      await entered.promise;
      const t0 = Date.now();
      p.signals.emit("SIGTERM", "SIGTERM");
      // The shutdown is under way (the setup still hangs): a second signal exits 1 at once
      p.signals.emit("SIGTERM", "SIGTERM");
      expect(p.exits).toEqual([1]);
      // The first signal's shutdown completes (the setup still hangs) without a second exit: the
      // forced exit stays 1
      expect(Date.now() - t0).toBeLessThan(10_000);
      expect(await eventually(async () => (await redisClients()) === baseline)).toBe(true);
      expect(await eventually(async () => (await kernelPgConnections()) === 0)).toBe(true);
      expect(p.signals.listenerCount("SIGTERM")).toBe(0);
      expect(p.signals.listenerCount("SIGINT")).toBe(0);
      expect(p.exits).toEqual([1]);
      // Once the setup returns, the aborted start rejects (in production the process has exited)
      gate.resolve();
      await expect(starting).rejects.toThrow(/closed during load/);
    } finally {
      gate.resolve();
      g[SLOW_GATES_KEY]?.delete(key);
    }
  }, 30_000);

  it("SIGTERM while a conversation runs: the run stops at a step boundary and goes back to the queue within the budget", async () => {
    const p = fakeProcess();
    const app = await startKernelApp(
      runConfig({ pg: pgc.url, redis: rd.url }, { roles: ["api", "worker"] }),
      { env: {}, logger: silent() },
      { signals: p.signals, exit: p.exit },
    );
    apps.push(app);
    const db = kernelDb(raw);
    await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" });
    const req = asUser(app.get(KernelLifecycle).http, cookieJar());
    expect(
      (
        await req({
          method: "POST",
          url: "/api/v1/auth/login",
          payload: { login: "owner", password: PW },
        })
      ).statusCode,
    ).toBe(200);
    const orgId = await createOrg(req);
    const agentId = await createAgent(req, orgId, { provider: "model-looper", model: "loop-1" });
    const convId = await createConv(req, orgId, agentId);
    await postMessage(req, orgId, convId, "loop:200");
    await waitFor(
      async () => (await eventsOf(db, convId)).some((e) => e.type === "model_call"),
      10_000,
      "model_call",
    );
    const t0 = Date.now();
    p.signals.emit("SIGTERM", "SIGTERM");
    expect(app.get(GracefulShutdown).isShuttingDown()).toBe(true);
    expect(await p.exited).toBe(0);
    expect(Date.now() - t0).toBeLessThan(10_000);
    // Interrupted, not finished: the job went back to the queue for another worker
    expect((await eventsOf(db, convId)).some((e) => e.type === "run_finished")).toBe(false);
    expect((await runsOf(db, convId))[0]?.status).toBe("running");
    expect(await kernelPgConnections()).toBe(0);
  }, 60_000);

  it("an event stream opened after the shutdown began ends at once; readiness answers 503", async () => {
    const p = fakeProcess();
    const app = await startKernelApp(
      runConfig({ pg: pgc.url, redis: rd.url }, { roles: ["api"] }),
      { env: {}, logger: silent() },
      { signals: p.signals, exit: p.exit },
    );
    apps.push(app);
    const lifecycle = app.get(KernelLifecycle);
    const db = kernelDb(raw);
    await accountsFor(db).createLocal({ login: "viewer", password: PW, displayName: "V" });
    const jar = cookieJar();
    const req = asUser(lifecycle.http, jar);
    expect(
      (
        await req({
          method: "POST",
          url: "/api/v1/auth/login",
          payload: { login: "viewer", password: PW },
        })
      ).statusCode,
    ).toBe(200);
    const orgId = await createOrg(req, "Streams");
    const agentId = await createAgent(req, orgId);
    const convId = await createConv(req, orgId, agentId);
    const base = `http://127.0.0.1:${lifecycle.port}`;
    const headers = { cookie: jar.header() as string };

    const before = await fetch(`${base}/api/v1/orgs/${orgId}/conversations/${convId}/stream`, {
      headers,
    });
    expect(before.status).toBe(200);
    const beforeBody = before.body?.getReader();
    await beforeBody?.read();

    // Only the shutdown state: the stop phases have not run, HTTP still serves
    app.get(GracefulShutdown).begin();
    expect((await fetch(`${base}/readyz`)).status).toBe(503);
    // The open stream was closed when the shutdown began
    const t0 = Date.now();
    for (;;) {
      const r = await beforeBody?.read();
      if (r === undefined || r.done) break;
    }
    // A stream opened now ends right after its headers
    const late = await fetch(`${base}/api/v1/orgs/${orgId}/conversations/${convId}/stream`, {
      headers,
    });
    expect(late.status).toBe(200);
    expect(await late.text()).toBe("");
    const ui = await fetch(`${base}/api/v1/orgs/${orgId}/ui/stream`, { headers });
    expect(ui.status).toBe(200);
    expect(await ui.text()).toBe("");
    expect(Date.now() - t0).toBeLessThan(2_000);
  }, 60_000);

  it("listen() after the shutdown began rejects and opens no port", async () => {
    const app = await createKernelApp(runConfig({ pg: pgc.url, redis: rd.url }), {
      env: {},
      logger: silent(),
    });
    apps.push(app);
    const lifecycle = app.get(KernelLifecycle);
    app.get(GracefulShutdown).begin();
    await expect(lifecycle.listen(0)).rejects.toThrow(/stopped during start/);
    expect(lifecycle.port).toBeUndefined();
  }, 60_000);

  it("a hanging webhooks unsubscribe does not hold the stop beyond its budget", async () => {
    const app = await createKernelApp(runConfig({ pg: pgc.url, redis: rd.url }), {
      env: {},
      logger: silent(),
    });
    apps.push(app);
    const gateway = app.get(GatewayRole) as unknown as {
      unsubscribeWebhooks: () => Promise<void>;
    };
    gateway.unsubscribeWebhooks = () => new Promise<void>(() => {});
    const t0 = Date.now();
    await closeKernelApp(app);
    expect(Date.now() - t0).toBeLessThan(6_000);
  }, 60_000);

  it("createKernelApp installs no process-wide handler", async () => {
    const events = ["SIGTERM", "SIGINT", "unhandledRejection", "uncaughtException"] as const;
    const before = events.map((e) => process.listenerCount(e));
    const app = await createKernelApp(runConfig({ pg: pgc.url, redis: rd.url }), {
      env: {},
      logger: silent(),
    });
    apps.push(app);
    expect(events.map((e) => process.listenerCount(e))).toEqual(before);
  }, 60_000);
});
