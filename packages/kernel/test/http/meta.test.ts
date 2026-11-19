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
      icons: { app: null, maskable: null, favicon: null },
      // device protocol 4 only: a protocol 3 program is refused (426)
      protocols: { device: { min: 4, max: 4 } },
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

  it("returns each platform icon URL, null for the default; icon is icons.app", async () => {
    const db = app.get(KernelDb);
    const get = async () => (await app.inject({ method: "GET", url: "/api/v1/meta" })).json();
    expect((await get()).icons).toEqual({ app: null, maskable: null, favicon: null });
    const sha = (c: string) => c.repeat(64);
    for (const [purpose, c] of [
      ["app", "a"],
      ["maskable", "b"],
      ["favicon", "c"],
    ] as const) {
      await db
        .insertInto("platform_icons")
        .values({ purpose, object_key: "k", sha256: sha(c), content_type: "image/png" })
        .execute();
      const body = await get();
      expect(body.icons[purpose]).toBe(`/api/v1/platform/icon/${purpose}?v=${sha(c)}`);
    }
    const body = await get();
    expect(body.icon).toBe(body.icons.app);
    await db.deleteFrom("platform_icons").where("purpose", "=", "maskable").execute();
    expect((await get()).icons.maskable).toBeNull();
    expect((await get()).icons.app).not.toBeNull();
    await db.deleteFrom("platform_icons").execute();
  });
});
