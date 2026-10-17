import { describe, expect, it } from "vitest";
import { envOverrides } from "../../src/config/env.js";
import { ConfigError } from "../../src/config/types.js";

describe("envOverrides 冲突检测的边界", () => {
  it("同前缀但不是父子路径的键不冲突：CAPYBARA_DB__URL 与 CAPYBARA_DB__URL_EXTRA", () => {
    expect(envOverrides({ CAPYBARA_DB__URL: "postgres://x", CAPYBARA_DB__URL_EXTRA: "y" })).toEqual(
      { db: { url: "postgres://x", urlExtra: "y" } },
    );
  });

  it("顶层名互为字符串前缀不冲突：CAPYBARA_LOG 与 CAPYBARA_LOGGING__X", () => {
    expect(envOverrides({ CAPYBARA_LOG: "a", CAPYBARA_LOGGING__X: "b" })).toEqual({
      log: "a",
      logging: { x: "b" },
    });
  });

  it("配置来源变量先于冲突检测被忽略：CAPYBARA_CONFIG_SOURCE / CAPYBARA_NACOS_SERVER", () => {
    // 若忽略发生在冲突检测之后，NACOS_SERVER（nacosServer）与 NACOS_SERVER__PORT（nacosServer.port）会被判冲突
    expect(
      envOverrides({
        CAPYBARA_CONFIG_SOURCE: "nacos",
        CAPYBARA_CONFIG_SOURCE__X: "x",
        CAPYBARA_NACOS_SERVER: "127.0.0.1:8848",
        CAPYBARA_NACOS_SERVER__PORT: "8848",
        CAPYBARA_HTTP__PORT: "8080",
      }),
    ).toEqual({ http: { port: 8080 } });
  });

  it("整段 JSON 与逐字段同时设置判冲突", () => {
    expect(() =>
      envOverrides({ CAPYBARA_DB: '{"url":"postgres://x"}', CAPYBARA_DB__POOL_MAX: "5" }),
    ).toThrow(ConfigError);
  });
});
