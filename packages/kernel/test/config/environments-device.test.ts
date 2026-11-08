import { describe, expect, it } from "vitest";
import { resolveConfig } from "../../src/config/load.js";
import { KernelConfigSchema } from "../../src/config/schema.js";

const base = {
  db: { url: "postgres://u:p@localhost/db" },
  redis: { url: "redis://localhost:6379" },
  masterKey: Buffer.alloc(32, 1).toString("base64"),
};

describe("environments.device config", () => {
  it("environments.device defaults", () => {
    const c = KernelConfigSchema.parse(base);
    expect(c.environments.device).toEqual({
      reconnectGraceSeconds: 120,
      leaseTtlMs: 30000,
      authCodeTtlSeconds: 600,
      pollIntervalSeconds: 5,
      maxFrameBytes: 16777216,
    });
    expect(c.environments.maxPersonal).toBe(10);
  });

  it("rejects a lease TTL below 6000 ms", () => {
    expect(() =>
      KernelConfigSchema.parse({ ...base, environments: { device: { leaseTtlMs: 1000 } } }),
    ).toThrow();
    const c = KernelConfigSchema.parse({ ...base, environments: { device: { leaseTtlMs: 6000 } } });
    expect(c.environments.device.leaseTtlMs).toBe(6000);
  });

  it("environment variables override single fields", () => {
    const c = resolveConfig(
      {},
      {
        CAPYBARA_DB__URL: base.db.url,
        CAPYBARA_REDIS__URL: base.redis.url,
        CAPYBARA_MASTER_KEY: base.masterKey,
        CAPYBARA_ENVIRONMENTS__DEVICE__RECONNECT_GRACE_SECONDS: "60",
      },
    );
    expect(c.environments.device.reconnectGraceSeconds).toBe(60);
    expect(c.environments.device.pollIntervalSeconds).toBe(5);
  });
});
