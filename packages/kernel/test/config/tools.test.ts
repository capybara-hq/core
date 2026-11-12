import { describe, expect, it } from "vitest";
import { resolveConfig } from "../../src/config/load.js";
import { KernelConfigSchema } from "../../src/config/schema.js";

const base = {
  db: { url: "postgres://u:p@localhost/db" },
  redis: { url: "redis://localhost:6379" },
  masterKey: Buffer.alloc(32, 1).toString("base64"),
};

describe("tools 配置段", () => {
  it("默认值", () => {
    const c = KernelConfigSchema.parse(base);
    expect(c.tools).toEqual({
      timeoutMs: 60000,
      breakerFailures: 5,
      breakerOpenSeconds: 60,
      outputSpillChars: 50000,
      outputPreviewChars: 2000,
      outputRetentionDays: 30,
      approvalTimeoutHours: 24,
      searchThresholdTools: 30,
      searchThresholdTokens: 8000,
      driftIntervalHours: 24,
      maxResultReadChars: 20000,
      oauthAllowInsecureLoopback: false,
      git: {
        enabled: true,
        maxBytesPerRun: 5368709120,
        idleTimeoutMs: 60000,
        maxConcurrentPerOrg: 8,
        ticketTtlSeconds: 900,
      },
    });
    expect(c.http.publicUrl).toBeUndefined();
  });

  it("tools.git: partial override, bounds and gatewayUrl", () => {
    const c = KernelConfigSchema.parse({ ...base, tools: { git: { maxConcurrentPerOrg: 2 } } });
    expect(c.tools.git.maxConcurrentPerOrg).toBe(2);
    expect(c.tools.git.enabled).toBe(true);
    expect(c.tools.git.gatewayUrl).toBeUndefined();
    const url = KernelConfigSchema.parse({
      ...base,
      tools: { git: { gatewayUrl: "https://k.internal:8080" } },
    });
    expect(url.tools.git.gatewayUrl).toBe("https://k.internal:8080");
    for (const git of [
      { ticketTtlSeconds: 1 },
      { maxConcurrentPerOrg: 0 },
      { idleTimeoutMs: 10 },
      { maxBytesPerRun: 1 },
      { gatewayUrl: "not a url" },
      { gatewayUrl: "ftp://k.internal" },
      { gatewayUrl: "https://k.internal/git" },
      { gatewayUrl: "https://u:p@k.internal" },
      { gatewayUrl: "https://k.internal/?a=1" },
    ]) {
      expect(KernelConfigSchema.safeParse({ ...base, tools: { git } }).success).toBe(false);
    }
  });

  it("部分覆盖时其余字段保持默认", () => {
    const c = KernelConfigSchema.parse({ ...base, tools: { timeoutMs: 1000 } });
    expect(c.tools.timeoutMs).toBe(1000);
    expect(c.tools.breakerFailures).toBe(5);
  });

  it("环境变量覆盖（驼峰 <-> 双下划线）", () => {
    const c = resolveConfig(
      {},
      {
        CAPYBARA_DB__URL: base.db.url,
        CAPYBARA_REDIS__URL: base.redis.url,
        CAPYBARA_MASTER_KEY: base.masterKey,
        CAPYBARA_TOOLS__OUTPUT_SPILL_CHARS: "1234",
        CAPYBARA_HTTP__PUBLIC_URL: "https://capybara.example.com",
      },
    );
    expect(c.tools.outputSpillChars).toBe(1234);
    expect(c.http.publicUrl).toBe("https://capybara.example.com");
  });

  it("非法值被拒绝", () => {
    expect(() => KernelConfigSchema.parse({ ...base, tools: { timeoutMs: 0 } })).toThrow();
    expect(() => KernelConfigSchema.parse({ ...base, http: { publicUrl: "not a url" } })).toThrow();
  });
});
