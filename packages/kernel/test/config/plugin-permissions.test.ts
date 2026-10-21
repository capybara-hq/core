import { describe, expect, it } from "vitest";
import { configFields } from "../../src/config/fields.js";
import { resolveConfig } from "../../src/config/load.js";
import { KernelConfigSchema } from "../../src/config/schema.js";

const base = {
  db: { url: "postgres://u:p@localhost/db" },
  redis: { url: "redis://localhost:6379" },
  masterKey: Buffer.alloc(32, 1).toString("base64"),
};

describe("pluginPermissions 配置段", () => {
  it("默认不自动批准，且不可热更新", () => {
    expect(KernelConfigSchema.parse(base).pluginPermissions).toEqual({ autoApprove: false });
    const f = configFields(KernelConfigSchema).find(
      (x) => x.path === "pluginPermissions.autoApprove",
    );
    expect(f?.meta?.hot).not.toBe(true);
  });

  it("环境变量开启", () => {
    const c = resolveConfig(
      {},
      {
        CAPYBARA_DB__URL: base.db.url,
        CAPYBARA_REDIS__URL: base.redis.url,
        CAPYBARA_MASTER_KEY: base.masterKey,
        CAPYBARA_PLUGIN_PERMISSIONS__AUTO_APPROVE: "true",
      },
    );
    expect(c.pluginPermissions.autoApprove).toBe(true);
  });
});
