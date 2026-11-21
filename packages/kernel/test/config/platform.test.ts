import { describe, expect, it } from "vitest";
import { CHANNEL_PHRASES, phrase } from "../../src/channels/phrases.js";
import { resolveConfig } from "../../src/config/load.js";
import { DEFAULT_PRODUCT_NAME, productName } from "../../src/config/product-name.js";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { gitSays } from "../../src/git/gateway.js";

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

describe("the product name people see (platform.name, issue #452)", () => {
  const named = KernelConfigSchema.parse({ ...base, platform: { name: "Acme Agents" } });
  const unnamed = KernelConfigSchema.parse(base);

  it("is platform.name, else Capybara", () => {
    expect(productName(named)).toBe("Acme Agents");
    expect(productName(unnamed)).toBe(DEFAULT_PRODUCT_NAME);
    expect(DEFAULT_PRODUCT_NAME).toBe("Capybara");
  });

  it("prefixes what the git gateway prints", () => {
    expect(gitSays(named)("internal error.")).toBe("Acme Agents: internal error.");
    expect(gitSays(unnamed)("internal error.")).toBe("Capybara: internal error.");
  });

  it("fills the IM phrases that name the platform, in both languages; no phrase says Capybara", () => {
    expect(phrase("bindPrompt", "en", "Acme Agents")).toBe(
      "Please link your Acme Agents account before chatting with me.",
    );
    expect(phrase("handleOnWeb", "zh", "Acme $& AI")).toBe(
      "有一条请求需要你到 Acme $& AI 网页上处理。",
    );
    for (const p of Object.values(CHANNEL_PHRASES)) {
      expect(p.zh).not.toContain("Capybara");
      expect(p.en).not.toContain("Capybara");
      expect(p.zh.includes("{product}")).toBe(p.en.includes("{product}"));
    }
  });
});
