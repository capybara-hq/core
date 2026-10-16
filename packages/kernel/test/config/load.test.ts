import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, selectConfigSource } from "../../src/index.js";

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
