import { describe, expect, it } from "vitest";
import { resolveConfig } from "../../src/config/load.js";
import { KernelConfigSchema } from "../../src/config/schema.js";

const base = {
  db: { url: "postgres://u:p@localhost/db" },
  redis: { url: "redis://localhost:6379" },
  masterKey: Buffer.alloc(32, 1).toString("base64"),
};

describe("platform.name config", () => {
  it("is unset by default", () => {
    expect(KernelConfigSchema.parse(base).platform.name).toBeUndefined();
  });

  it("keeps a configured name", () => {
    expect(
      KernelConfigSchema.parse({ ...base, platform: { name: "Example Corp" } }).platform.name,
    ).toBe("Example Corp");
  });

  it("rejects an empty name and a 65-character name", () => {
    expect(KernelConfigSchema.safeParse({ ...base, platform: { name: "" } }).success).toBe(false);
    expect(
      KernelConfigSchema.safeParse({ ...base, platform: { name: "a".repeat(65) } }).success,
    ).toBe(false);
    expect(
      KernelConfigSchema.safeParse({ ...base, platform: { name: "a".repeat(64) } }).success,
    ).toBe(true);
  });

  it("CAPYBARA_PLATFORM__NAME reaches platform.name", () => {
    const cfg = resolveConfig(
      {},
      {
        CAPYBARA_DB__URL: base.db.url,
        CAPYBARA_REDIS__URL: base.redis.url,
        CAPYBARA_MASTER_KEY: base.masterKey,
        CAPYBARA_PLATFORM__NAME: "Example",
      },
    );
    expect(cfg.platform.name).toBe("Example");
  });
});
