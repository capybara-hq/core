import { connect, createServer, type Socket } from "node:net";
import { startTestPostgres, startTestRedis } from "@capybara-hq/testing";
import { describe, expect, it } from "vitest";
import { type KernelConfig, KernelConfigSchema } from "../../src/config/schema.js";
import { createLogger } from "../../src/log.js";
import { startKernel } from "../helpers/runs.js";

const masterKey = Buffer.alloc(32, 7).toString("base64");
const ROLES = [["api"], ["worker"], ["gateway"]] as const;

const cfg = (roles: readonly string[], pgUrl: string, redisUrl: string): KernelConfig =>
  KernelConfigSchema.parse({
    roles,
    db: { url: pgUrl, poolMax: 3 },
    redis: { url: redisUrl },
    masterKey,
    marketplaces: { official: { enabled: false } },
    http: { port: 0 },
  });

/**
 * A TCP proxy in front of Redis that can play "Redis down" and recover. Stopping the Redis container
 * instead leaves the kernel's queues unable to close, so every close waited out the whole 30 s stop
 * budget; with Redis back before the close, the close is quick.
 */
async function redisProxy(redisUrl: string) {
  const target = new URL(redisUrl);
  const live = new Set<Socket>();
  let down = false;
  const server = createServer((client) => {
    if (down) {
      client.destroy();
      return;
    }
    const upstream = connect(Number(target.port), target.hostname);
    for (const s of [client, upstream]) {
      live.add(s);
      s.on("close", () => live.delete(s));
      s.on("error", () => {});
    }
    client.pipe(upstream).pipe(client);
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no proxy port");
  const url = new URL(redisUrl);
  url.hostname = "127.0.0.1";
  url.port = String(address.port);
  return {
    url: url.toString(),
    down() {
      down = true;
      // end, not destroy: a stopping Redis closes its connections, it doesn't reset them
      for (const s of live) s.end();
    },
    up() {
      down = false;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of live) s.destroy();
        server.close(() => resolve());
      }),
  };
}

describe.each(ROLES)("terminus health on roles %j", (...roles) => {
  async function boot() {
    const pgc = await startTestPostgres();
    const rd = await startTestRedis();
    const k = await startKernel(cfg(roles, pgc.url, rd.url), {
      env: {},
      logger: createLogger("error", { write: () => {} }),
    });
    const get = (url: string) => k.http.inject({ method: "GET", url });
    return { pgc, rd, k, get };
  }

  it("healthz is 200 { ok: true }; readyz is 200 with pg / redis ok", async () => {
    const { pgc, rd, k, get } = await boot();
    try {
      const h = await get("/healthz");
      expect(h.statusCode).toBe(200);
      expect(h.json()).toEqual({ ok: true });
      const r = await get("/readyz");
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({ ok: true, pg: "ok", redis: "ok" });
    } finally {
      await k.close();
      await Promise.all([pgc.stop(), rd.stop()]);
    }
  }, 120_000);

  it("database down: readyz 503 naming pg, healthz stays 200", async () => {
    const { pgc, rd, k, get } = await boot();
    try {
      await pgc.stop();
      const r = await get("/readyz");
      expect(r.statusCode).toBe(503);
      expect(r.json()).toEqual({ ok: false, pg: "error", redis: "ok" });
      expect(r.body).not.toContain("postgres://");
      expect((await get("/healthz")).statusCode).toBe(200);
    } finally {
      await k.close().catch(() => {});
      await rd.stop();
    }
  }, 120_000);

  it("redis down: readyz 503 naming redis", async () => {
    const pgc = await startTestPostgres();
    const rd = await startTestRedis();
    const proxy = await redisProxy(rd.url);
    const k = await startKernel(cfg(roles, pgc.url, proxy.url), {
      env: {},
      logger: createLogger("error", { write: () => {} }),
    });
    try {
      proxy.down();
      const r = await k.http.inject({ method: "GET", url: "/readyz" });
      expect(r.statusCode).toBe(503);
      expect(r.json()).toEqual({ ok: false, pg: "ok", redis: "error" });
      expect(r.body).not.toContain("redis://");
    } finally {
      proxy.up();
      await k.close().catch(() => {});
      await proxy.close();
      await Promise.all([pgc.stop(), rd.stop()]);
    }
  }, 120_000);

  it("shutting down: readyz 503 { ok: false, stopping: true } at once", async () => {
    const { pgc, rd, k, get } = await boot();
    try {
      const stopping = k.close();
      const r = await get("/readyz");
      expect(r.statusCode).toBe(503);
      expect(r.json()).toEqual({ ok: false, stopping: true });
      await stopping;
    } finally {
      await Promise.all([pgc.stop(), rd.stop()]);
    }
  }, 120_000);
});
