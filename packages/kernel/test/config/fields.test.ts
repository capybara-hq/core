import { describe, expect, it } from "vitest";
import { z } from "zod";
import { changedPaths, configFields, secretValues } from "../../src/config/fields.js";
import { resolveConfig } from "../../src/config/load.js";
import { KernelConfigSchema, meta } from "../../src/config/schema.js";

const masterKey = Buffer.alloc(32, 1).toString("base64");

describe("configFields", () => {
  it("从 schema 元信息列出叶子字段与 hot / secret 标记", () => {
    const fields = configFields(KernelConfigSchema);
    const byPath = new Map(fields.map((f) => [f.path, f.meta]));
    expect(byPath.get("log.level")?.hot).toBe(true);
    expect(byPath.get("http.port")?.hot).toBeFalsy();
    expect(byPath.get("db.url")?.secret).toBe(true);
    expect(byPath.get("masterKeyPrevious")?.secret).toBe(true);
    expect(fields.filter((f) => f.meta?.hot).map((f) => f.path)).toEqual(["log.level"]);
  });

  it("嵌套在 default / optional 里的对象也能展开", () => {
    const s = z.object({
      a: z
        .object({ b: z.string().meta(meta({ hot: true, description: "b" })) })
        .optional()
        .default({ b: "x" }),
    });
    expect(configFields(s).map((f) => f.path)).toEqual(["a.b"]);
  });
});

describe("changedPaths / secretValues", () => {
  const base = KernelConfigSchema.parse({
    db: { url: "postgres://u:pw@h/db" },
    redis: { url: "redis://h" },
    masterKey,
  });
  it("列出变化的叶子点路径", () => {
    const next = { ...base, http: { port: 1 }, log: { level: "debug" } };
    expect(changedPaths(KernelConfigSchema, base, next).sort()).toEqual(["http.port", "log.level"]);
  });
  it("收集 secret 字段的值（数组展开）", () => {
    const c = { ...base, masterKeyPrevious: [masterKey] };
    expect(secretValues(KernelConfigSchema, c).sort()).toEqual(
      ["postgres://u:pw@h/db", "redis://h", masterKey, masterKey].sort(),
    );
  });
});

describe("resolveConfig", () => {
  it("原始配置深合并环境变量覆盖后校验", () => {
    const c = resolveConfig(
      { db: { url: "postgres://a" }, redis: { url: "redis://a" }, masterKey },
      { CAPYBARA_HTTP__PORT: "9000" },
    );
    expect(c.http.port).toBe(9000);
    expect(c.db.url).toBe("postgres://a");
  });
  it("非法时抛 ConfigError 并列出路径", () => {
    expect(() => resolveConfig({ masterKey: "x" }, {})).toThrow(/masterKey/);
    expect(() => resolveConfig([], {})).toThrow(/mapping/);
  });
});
