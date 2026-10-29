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
    const { pgc, rd, k, get } = await boot();
    try {
      await rd.stop();
      const r = await get("/readyz");
      expect(r.statusCode).toBe(503);
      expect(r.json()).toEqual({ ok: false, pg: "ok", redis: "error" });
      expect(r.body).not.toContain("redis://");
    } finally {
      await k.close().catch(() => {});
      await pgc.stop();
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
