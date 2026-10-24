import { describe, expect, it } from "vitest";
import { webhookBase } from "../../src/channels/webhook-url.js";
import { ConfigError, resolveConfig } from "../../src/config/load.js";

const base = {
  db: { url: "postgres://u:p@localhost/db" },
  redis: { url: "redis://localhost:6379" },
  masterKey: Buffer.alloc(32, 1).toString("base64"),
};

describe("channels.webhookBaseUrl / webhookMaxBodyBytes", () => {
  it("defaults: no base URL, 1 MiB body limit", () => {
    const c = resolveConfig(base, {});
    expect(c.channels.webhookBaseUrl).toBeUndefined();
    expect(c.channels.webhookMaxBodyBytes).toBe(1_048_576);
    expect(webhookBase(c)).toBeUndefined();
  });

  it("https is accepted (trailing slash dropped); env overrides work", () => {
    const c = resolveConfig(base, {
      CAPYBARA_CHANNELS__WEBHOOK_BASE_URL: "https://im.example.com/",
      CAPYBARA_CHANNELS__WEBHOOK_MAX_BODY_BYTES: "2048",
    });
    expect(webhookBase(c)).toBe("https://im.example.com");
    expect(c.channels.webhookMaxBodyBytes).toBe(2048);
  });

  it("plain http is rejected, except loopback with tools.oauthAllowInsecureLoopback", () => {
    expect(() =>
      resolveConfig({ ...base, channels: { webhookBaseUrl: "http://im.example.com" } }, {}),
    ).toThrow(ConfigError);
    expect(() =>
      resolveConfig({ ...base, channels: { webhookBaseUrl: "http://127.0.0.1:8080" } }, {}),
    ).toThrow(/channels\.webhookBaseUrl/);
    const c = resolveConfig(
      {
        ...base,
        channels: { webhookBaseUrl: "http://127.0.0.1:8080" },
        tools: { oauthAllowInsecureLoopback: true },
      },
      {},
    );
    expect(webhookBase(c)).toBe("http://127.0.0.1:8080");
    expect(() =>
      resolveConfig({ ...base, channels: { webhookBaseUrl: "ftp://im.example.com" } }, {}),
    ).toThrow(ConfigError);
  });
});
