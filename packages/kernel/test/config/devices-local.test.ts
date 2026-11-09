import { describe, expect, it } from "vitest";
import { resolveConfig } from "../../src/config/load.js";
import { KernelConfigSchema } from "../../src/config/schema.js";

const base = {
  db: { url: "postgres://u:p@localhost/db" },
  redis: { url: "redis://localhost:6379" },
  masterKey: Buffer.alloc(32, 1).toString("base64"),
};

describe("devices.local config", () => {
  it("devices.local defaults", () => {
    const c = KernelConfigSchema.parse(base);
    expect(c.devices.local).toEqual({
      reconnectGraceSeconds: 120,
      leaseTtlMs: 30000,
      authCodeTtlSeconds: 600,
      pollIntervalSeconds: 5,
      maxFrameBytes: 16777216,
    });
    expect(c.devices.maxPersonal).toBe(10);
  });

  it("rejects a lease TTL below 6000 ms", () => {
    const r = KernelConfigSchema.safeParse({
      ...base,
      devices: { local: { leaseTtlMs: 1000 } },
    });
    expect(r.success).toBe(false);
    expect(r.error?.issues).toEqual([
      expect.objectContaining({
        code: "too_small",
        minimum: 6000,
        path: ["devices", "local", "leaseTtlMs"],
      }),
    ]);
    const c = KernelConfigSchema.parse({ ...base, devices: { local: { leaseTtlMs: 6000 } } });
    expect(c.devices.local.leaseTtlMs).toBe(6000);
  });

  it("environment variables override single fields", () => {
    const c = resolveConfig(
      {},
      {
        CAPYBARA_DB__URL: base.db.url,
        CAPYBARA_REDIS__URL: base.redis.url,
        CAPYBARA_MASTER_KEY: base.masterKey,
        CAPYBARA_DEVICES__LOCAL__RECONNECT_GRACE_SECONDS: "60",
      },
    );
    expect(c.devices.local.reconnectGraceSeconds).toBe(60);
    expect(c.devices.local.pollIntervalSeconds).toBe(5);
  });
});
