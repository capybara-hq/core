import { describe, expect, it } from "vitest";
import { ConfigError, resolveConfig } from "../../src/config/load.js";
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

  it("devices.autoMode: unset by the config source (the deployment setting / default decides)", () => {
    // no schema default: readDevicesAutoMode can tell "the source set it" from "it is the default"
    expect(KernelConfigSchema.parse(base).devices.autoMode).toBeUndefined();
    expect(
      KernelConfigSchema.parse({ ...base, devices: { autoMode: "off" } }).devices.autoMode,
    ).toBe("off");
    expect(KernelConfigSchema.safeParse({ ...base, devices: { autoMode: "maybe" } }).success).toBe(
      false,
    );
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
        CAPYBARA_DEVICES__AUTO_MODE: "off",
      },
    );
    expect(c.devices.local.reconnectGraceSeconds).toBe(60);
    expect(c.devices.local.pollIntervalSeconds).toBe(5);
    expect(c.devices.autoMode).toBe("off");
  });
});

describe("removed sandbox keys fail loudly", () => {
  // a silently ignored security key reads as a widening (auto mode hardening spec K3)
  const env = {
    CAPYBARA_DB__URL: base.db.url,
    CAPYBARA_REDIS__URL: base.redis.url,
    CAPYBARA_MASTER_KEY: base.masterKey,
  };

  it("sandbox.tiers in the loaded config fails, naming devices.autoMode and cloudNetwork", () => {
    const run = () =>
      resolveConfig({ ...base, sandbox: { tiers: { max: "open", allowUnsandboxed: false } } }, {});
    expect(run).toThrow(ConfigError);
    expect(run).toThrow(/sandbox\.tiers.*removed/);
    expect(run).toThrow(/devices\.autoMode/);
    expect(run).toThrow(/cloudNetwork/);
  });

  it("sandbox.limits.devHosts fails, naming the allowlist that replaces it", () => {
    const run = () =>
      resolveConfig({ ...base, sandbox: { limits: { devHosts: ["dev.example.com"] } } }, {});
    expect(run).toThrow(/sandbox\.limits\.devHosts.*removed/);
    expect(run).toThrow(/sandbox\.limits\.allowHosts/);
  });

  it("the same keys from the environment fail too", () => {
    expect(() => resolveConfig({}, { ...env, CAPYBARA_SANDBOX__TIERS__MAX: "open" })).toThrow(
      /sandbox\.tiers.*devices\.autoMode/s,
    );
    expect(() =>
      resolveConfig({}, { ...env, CAPYBARA_SANDBOX__LIMITS__DEV_HOSTS: '["dev.example.com"]' }),
    ).toThrow(/sandbox\.limits\.devHosts/);
  });

  it("sandbox.limits.egress: open fails, naming devices.autoMode and cloudNetwork", () => {
    const run = () => resolveConfig({}, { ...env, CAPYBARA_SANDBOX__LIMITS__EGRESS: "open" });
    expect(run).toThrow(/sandbox\.limits\.egress/);
    expect(run).toThrow(/devices\.autoMode/);
    expect(run).toThrow(/cloudNetwork/);
  });

  it("every removed key is listed at once", () => {
    const run = () =>
      resolveConfig(
        { ...base, sandbox: { tiers: {}, limits: { devHosts: [], egress: "open" } } },
        {},
      );
    expect(run).toThrow(
      /sandbox\.tiers[\s\S]*sandbox\.limits\.devHosts[\s\S]*sandbox\.limits\.egress/,
    );
  });
});

describe("sandbox.review", () => {
  it("defaults and env names", () => {
    const c = KernelConfigSchema.parse(base);
    expect(c.sandbox.review).toEqual({ timeoutMs: 10_000, messageTokens: 1_500 });
    const env = resolveConfig(
      {},
      {
        CAPYBARA_DB__URL: base.db.url,
        CAPYBARA_REDIS__URL: base.redis.url,
        CAPYBARA_MASTER_KEY: base.masterKey,
        CAPYBARA_SANDBOX__REVIEW__TIMEOUT_MS: "2000",
        CAPYBARA_SANDBOX__REVIEW__MESSAGE_TOKENS: "750",
      },
    );
    expect(env.sandbox.review).toEqual({ timeoutMs: 2000, messageTokens: 750 });
  });
});
