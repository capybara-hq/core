import { DEVICE_PROTOCOL_VERSION } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeKernelApp, createKernelApp } from "../../src/app.js";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { KernelConfigService } from "../../src/infra/config/kernel-config.service.js";
import { KernelDb } from "../../src/infra/database/kernel-db.js";
import { createLogger } from "../../src/log.js";

let pgc: TestContainer;
let rd: TestContainer;
let app: NestFastifyApplication;

const rawConfig = () => ({
  db: { url: pgc.url },
  redis: { url: rd.url },
  masterKey: Buffer.alloc(32, 7).toString("base64"),
  marketplaces: { official: { enabled: false } },
  http: { port: 0 },
});

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  app = await createKernelApp(KernelConfigSchema.parse(rawConfig()), {
    env: {},
    logger: createLogger("error", { write: () => {} }),
  });
});
afterAll(async () => {
  if (app) await closeKernelApp(app);
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

describe("GET /api/v1/meta", () => {
  it("answers without a session, uncached", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/meta" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.json()).toEqual({
      name: null,
      icon: null,
      protocols: { device: { min: 3, max: 3 } },
      features: { localDevices: true, appSignIn: false },
    });
  });

  it("takes the device range from the SDK", async () => {
    const body = (await app.inject({ method: "GET", url: "/api/v1/meta" })).json();
    expect(body.protocols.device).toEqual({
      min: DEVICE_PROTOCOL_VERSION,
      max: DEVICE_PROTOCOL_VERSION,
    });
  });

  it("returns platform.name when set", async () => {
    // platform.name is hot: a reload applies it without a restart
    await app
      .get(KernelConfigService)
      .apply({ ...rawConfig(), platform: { name: "Example Corp" } });
    const res = await app.inject({ method: "GET", url: "/api/v1/meta" });
    expect(res.json().name).toBe("Example Corp");
  });

  it("reports appSignIn only when http.publicUrl is set", async () => {
    // http.publicUrl is not hot, so the configured value is swapped under the service.
    const config = app.get(KernelConfigService);
    const real = config.get();
    const spy = vi
      .spyOn(config, "get")
      .mockReturnValue({ ...real, http: { ...real.http, publicUrl: "https://cap.example.com" } });
    const on = (await app.inject({ method: "GET", url: "/api/v1/meta" })).json();
    spy.mockRestore();
    expect(on.features.appSignIn).toBe(true);
    const off = (await app.inject({ method: "GET", url: "/api/v1/meta" })).json();
    expect(off.features.appSignIn).toBe(false);
  });

  it("returns the platform icon URL, null for the default", async () => {
    const db = app.get(KernelDb);
    expect((await app.inject({ method: "GET", url: "/api/v1/meta" })).json().icon).toBeNull();
    const sha256 = "a".repeat(64);
    await db
      .insertInto("platform_icons")
      .values({ purpose: "app", object_key: "k", sha256, content_type: "image/png" })
      .execute();
    const res = await app.inject({ method: "GET", url: "/api/v1/meta" });
    expect(res.json().icon).toBe(`/api/v1/platform/icon/app?v=${sha256}`);
    await db.deleteFrom("platform_icons").execute();
  });
});
