import { describe, expect, it } from "vitest";
import { marketplaceNetPolicy } from "../../src/catalog/marketplace-fetch.js";
import { secretValues } from "../../src/config/fields.js";
import { resolveConfig } from "../../src/config/load.js";
import { KernelConfigSchema } from "../../src/config/schema.js";

const base = {
  db: { url: "postgres://u:p@localhost/db" },
  redis: { url: "redis://localhost:6379" },
  masterKey: Buffer.alloc(32, 1).toString("base64"),
};

describe("net.httpsProxy / net.noProxy", () => {
  it("defaults to no proxy: the marketplace policy has none", () => {
    const c = resolveConfig(base, {});
    expect(c.net.httpsProxy).toBeUndefined();
    expect(c.net.noProxy).toEqual([]);
    expect(marketplaceNetPolicy(c).proxy).toBeUndefined();
  });

  it("is read from the environment and reaches the marketplace policy", () => {
    const c = resolveConfig(base, {
      CAPYBARA_NET__HTTPS_PROXY: "http://u:pw@proxy.internal:3128",
      CAPYBARA_NET__NO_PROXY: '["git.internal", ".corp.example"]',
    });
    expect(marketplaceNetPolicy(c).proxy).toEqual({
      url: "http://u:pw@proxy.internal:3128",
      noProxy: ["git.internal", ".corp.example"],
    });
  });

  it("is a secret: the value is redacted and an invalid one is not echoed", () => {
    const c = resolveConfig(base, { CAPYBARA_NET__HTTPS_PROXY: "http://u:pw@proxy.internal:3128" });
    expect(secretValues(KernelConfigSchema, c)).toContain("http://u:pw@proxy.internal:3128");
    let message = "";
    try {
      resolveConfig(base, { CAPYBARA_NET__HTTPS_PROXY: "socks5://u:topsecret@p:1080" });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/net\.httpsProxy/);
    expect(message).not.toContain("topsecret");
  });

  it("refuses a noProxy entry with a scheme, port or wildcard", () => {
    for (const bad of ["https://git.internal", "git.internal:443", "*.corp.example"]) {
      expect(() => resolveConfig({ ...base, net: { noProxy: [bad] } }, {})).toThrow(/net\.noProxy/);
    }
  });
});
