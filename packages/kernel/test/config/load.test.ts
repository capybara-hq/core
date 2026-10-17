import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, envOverrides, loadConfig, selectConfigSource } from "../../src/index.js";

const MASTER_KEY = Buffer.alloc(32, 1).toString("base64");

function baseEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    CAPYBARA_DB__URL: "postgres://u:p@localhost/db",
    CAPYBARA_REDIS__URL: "redis://localhost:6379",
    CAPYBARA_MASTER_KEY: MASTER_KEY,
    ...extra,
  };
}

function writeYaml(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "capybara-config-"));
  const file = join(dir, "config.yaml");
  writeFileSync(file, content);
  return file;
}

describe("loadConfig", () => {
  it("file source + env override", async () => {
    const file = writeYaml("http: { port: 9000 }\n");
    const config = await loadConfig(
      baseEnv({ CAPYBARA_CONFIG_FILE: file, CAPYBARA_HTTP__PORT: "9100" }),
    );
    expect(config.http.port).toBe(9100);
  });

  it("file values are used when no override", async () => {
    const file = writeYaml("http: { port: 9000 }\n");
    const config = await loadConfig(baseEnv({ CAPYBARA_CONFIG_FILE: file }));
    expect(config.http.port).toBe(9000);
    expect(config.db.poolMax).toBe(10);
    expect(config.roles).toEqual(["api", "worker", "gateway"]);
  });

  it("nested snake to camel", async () => {
    const config = await loadConfig(baseEnv({ CAPYBARA_DB__POOL_MAX: "20" }));
    expect(config.db.poolMax).toBe(20);
  });

  it("bad type names the key", async () => {
    await expect(loadConfig(baseEnv({ CAPYBARA_DB__POOL_MAX: "abc" }))).rejects.toThrow(
      /db\.poolMax/,
    );
  });

  it("missing required names the key", async () => {
    const env = baseEnv();
    delete env.CAPYBARA_DB__URL;
    const err = await loadConfig(env).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toMatch(/db\.url/);
  });

  it("bad master key", async () => {
    await expect(
      loadConfig(baseEnv({ CAPYBARA_MASTER_KEY: Buffer.alloc(16).toString("base64") })),
    ).rejects.toThrow(/masterKey/);
  });

  it("unknown source", async () => {
    await expect(loadConfig(baseEnv({ CAPYBARA_CONFIG_SOURCE: "consul" }))).rejects.toThrow(
      /consul/,
    );
    expect(() => selectConfigSource({ CAPYBARA_CONFIG_SOURCE: "consul" })).toThrow(ConfigError);
  });

  it("JSON values are parsed", async () => {
    const config = await loadConfig(baseEnv({ CAPYBARA_PLUGINS: '["a","b"]' }));
    expect(config.plugins).toEqual(["a", "b"]);
  });
});

describe("envOverrides", () => {
  it("keeps strings that do not round-trip as numbers", () => {
    const env = {
      CAPYBARA_PLUGIN_CONFIG__X__A: "0123",
      CAPYBARA_PLUGIN_CONFIG__X__B: "1e3",
      CAPYBARA_PLUGIN_CONFIG__X__C: "12345678901234567890",
      CAPYBARA_PLUGIN_CONFIG__X__D: "1.0",
      CAPYBARA_PLUGIN_CONFIG__X__E: "123456",
      CAPYBARA_PLUGIN_CONFIG__X__F: "true",
    };
    expect(envOverrides(env)).toEqual({
      pluginConfig: {
        x: {
          a: "0123",
          b: "1e3",
          c: "12345678901234567890",
          d: "1.0",
          e: 123456,
          f: true,
        },
      },
    });
  });

  it("ignores CONFIG_* and NACOS_* keys", () => {
    expect(
      envOverrides({
        CAPYBARA_CONFIG_SOURCE: "file",
        CAPYBARA_CONFIG_FILE: "/x",
        CAPYBARA_NACOS_SERVER: "h",
        CAPYBARA_HTTP__PORT: "1",
      }),
    ).toEqual({ http: { port: 1 } });
  });
});

describe("file source errors", () => {
  it("missing file names the path", async () => {
    const err = await loadConfig(baseEnv({ CAPYBARA_CONFIG_FILE: "/nonexistent/c.yaml" })).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toContain("/nonexistent/c.yaml");
  });

  it("malformed YAML does not leak source", async () => {
    const file = writeYaml("db:\n  url: SUPERSECRET123\n bad: [unclosed\n");
    const err = await loadConfig(baseEnv({ CAPYBARA_CONFIG_FILE: file })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toContain(file);
    expect((err as Error).message).not.toContain("SUPERSECRET123");
  });

  it("list root is rejected", async () => {
    const file = writeYaml("- a\n- b\n");
    await expect(loadConfig(baseEnv({ CAPYBARA_CONFIG_FILE: file }))).rejects.toThrow(
      /root must be a mapping/,
    );
  });
});

describe("envOverrides 插件寻址与冲突", () => {
  it("plugin name segment maps to kebab", () => {
    const o = envOverrides({
      CAPYBARA_PLUGIN_CONFIG__EXAMPLE_COUNTER__STEP: "2",
      CAPYBARA_PLUGIN_CONFIG__EXAMPLE_COUNTER__POOL_SIZE: "3",
    }) as { pluginConfig: Record<string, Record<string, unknown>> };
    expect(o.pluginConfig["example-counter"]?.step).toBe(2);
    expect(o.pluginConfig["example-counter"]?.poolSize).toBe(3);
  });

  it("scalar vs nested conflict", () => {
    const env = { CAPYBARA_DB: "x", CAPYBARA_DB__URL: "postgres://h/d" };
    expect(() => envOverrides(env)).toThrow(ConfigError);
    expect(() => envOverrides(env)).toThrow(/CAPYBARA_DB\b/);
    expect(() => envOverrides(env)).toThrow(/CAPYBARA_DB__URL/);
  });

  it("empty config source means default", async () => {
    const file = writeYaml("http: { port: 9000 }\n");
    const config = await loadConfig(
      baseEnv({ CAPYBARA_CONFIG_SOURCE: "", CAPYBARA_CONFIG_FILE: file }),
    );
    expect(config.http.port).toBe(9000);
  });
});
