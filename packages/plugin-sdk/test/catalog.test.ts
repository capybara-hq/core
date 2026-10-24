import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import {
  CATALOG_SCHEMA_VERSION,
  type CatalogEntry,
  CatalogIndexSchema,
  compatibleVersions,
  parseCatalogIndex,
} from "../src/index.js";

const SHA = `sha512-${"A".repeat(86)}==`;

const pluginEntry = (over: Partial<CatalogEntry> = {}): CatalogEntry => ({
  kind: "plugin",
  name: "todo",
  npm: "@capybara-hq/plugin-todo",
  publisher: "Capybara",
  summary: { en: "Todo lists", zh: "待办" },
  permissions: { keys: ["permissions.tools:write", "table:todos"], sensitive: [] },
  versions: [{ version: "0.1.0", integrity: SHA, minKernel: "0.1.0", minSdk: "0.1.0" }],
  ...over,
});

const index = (entries: unknown[] = [pluginEntry()]) => ({
  schemaVersion: 1,
  name: "Official",
  updatedAt: "2026-10-22T00:00:00Z",
  entries,
});

const errorsOf = (json: unknown): string[] => {
  const r = parseCatalogIndex(json);
  return "errors" in r ? r.errors : [];
};

describe("parseCatalogIndex", () => {
  it("accepts the kernel's policy hook permission key (N-1)", () => {
    const e = pluginEntry({
      permissions: {
        keys: ["permissions.hooks:tool.preExecute", "permissions.hooks.policy:tool.preExecute"],
        sensitive: ["permissions.hooks.policy:tool.preExecute"],
      },
    });
    expect(errorsOf(index([e]))).toEqual([]);
  });

  it("合法清单通过，返回解析结果", () => {
    expect(CATALOG_SCHEMA_VERSION).toBe(1);
    const r = parseCatalogIndex(index());
    expect("errors" in r).toBe(false);
    expect((r as { entries: CatalogEntry[] }).entries[0]?.name).toBe("todo");
  });

  it("缺 integrity", () => {
    const e = pluginEntry();
    delete (e.versions[0] as { integrity?: string }).integrity;
    expect(errorsOf(index([e])).join("\n")).toMatch(/integrity/);
  });

  it("integrity 格式不对（sha256 / 长度不对）", () => {
    for (const integrity of [`sha256-${"A".repeat(43)}=`, `sha512-${"A".repeat(10)}==`]) {
      const e = pluginEntry({
        versions: [{ version: "0.1.0", integrity, minKernel: "0.1.0", minSdk: "0.1.0" }],
      });
      expect(errorsOf(index([e])).join("\n")).toMatch(/integrity/);
    }
  });

  it("版本重复", () => {
    const v = { version: "0.1.0", integrity: SHA, minKernel: "0.1.0", minSdk: "0.1.0" };
    expect(errorsOf(index([pluginEntry({ versions: [v, { ...v }] })])).join("\n")).toMatch(
      /duplicate version 0\.1\.0/,
    );
  });

  it("同一清单内 (kind, name) 重复", () => {
    expect(errorsOf(index([pluginEntry(), pluginEntry()])).join("\n")).toMatch(
      /duplicate entry plugin todo/,
    );
    // 不同 kind 同名可以
    const skill = {
      kind: "skill",
      name: "todo",
      npm: "@acme/skill-todo",
      publisher: "Acme",
      summary: { en: "x" },
      versions: [{ version: "1.0.0", integrity: SHA, minKernel: "0.1.0" }],
    };
    expect(errorsOf(index([pluginEntry(), skill]))).toEqual([]);
  });

  it("sensitive 不是 keys 的子集", () => {
    const e = pluginEntry({
      permissions: { keys: ["table:todos"], sensitive: ["permissions.secrets"] },
    });
    expect(errorsOf(index([e])).join("\n")).toMatch(/sensitive/);
  });

  it("plugin 缺 minSdk", () => {
    const e = pluginEntry({ versions: [{ version: "0.1.0", integrity: SHA, minKernel: "0.1.0" }] });
    expect(errorsOf(index([e])).join("\n")).toMatch(/minSdk/);
  });

  it("tarball 与 homepage 只认 https；schemaVersion 必须为 1；条目数有上限", () => {
    const http = pluginEntry({
      versions: [
        {
          version: "0.1.0",
          integrity: SHA,
          minKernel: "0.1.0",
          minSdk: "0.1.0",
          tarball: "http://example.com/x.tgz",
        },
      ],
    });
    expect(errorsOf(index([http])).join("\n")).toMatch(/tarball/);
    expect(errorsOf(index([pluginEntry({ homepage: "ftp://x" })])).join("\n")).toMatch(/homepage/);
    expect(errorsOf({ ...index(), schemaVersion: 2 }).length).toBeGreaterThan(0);
    const many = Array.from({ length: 5001 }, (_, i) => pluginEntry({ name: `p${i}` }));
    expect(errorsOf(index(many)).length).toBeGreaterThan(0);
  });

  it("allowInsecureLoopback 时 tarball 可用回环地址上的 http（只供测试）", () => {
    const e = pluginEntry({
      versions: [
        {
          version: "0.1.0",
          integrity: SHA,
          minKernel: "0.1.0",
          minSdk: "0.1.0",
          tarball: "http://127.0.0.1:1234/x.tgz",
        },
      ],
    });
    expect(errorsOf(index([e])).length).toBeGreaterThan(0);
    expect("errors" in parseCatalogIndex(index([e]), { allowInsecureLoopback: true })).toBe(false);
  });

  it("非对象 / 非 JSON 结构返回 errors 而不是抛错", () => {
    for (const bad of [null, 1, "x", [], { schemaVersion: 1 }]) {
      expect(errorsOf(bad).length).toBeGreaterThan(0);
    }
  });
});

describe("compatibleVersions", () => {
  it("按最低内核 / SDK 版本过滤，从新到旧", () => {
    const e = pluginEntry({
      versions: [
        { version: "0.1.0", integrity: SHA, minKernel: "0.1.0", minSdk: "0.1.0" },
        { version: "0.3.0", integrity: SHA, minKernel: "9.0.0", minSdk: "0.1.0" },
        { version: "0.2.0", integrity: SHA, minKernel: "0.1.0", minSdk: "0.1.0" },
        { version: "0.4.0", integrity: SHA, minKernel: "0.1.0", minSdk: "0.2.0" },
      ],
    });
    expect(compatibleVersions(e, { kernel: "0.1.0", sdk: "0.1.0" }).map((v) => v.version)).toEqual([
      "0.2.0",
      "0.1.0",
    ]);
  });
});

/**
 * 仓库里提交的 JSON Schema（由 `pnpm gen:package-schemas` 从 CatalogIndexSchema 生成，`check:package-schemas`
 * 保证不漂移）与 zod 的判断一致。JSON Schema 表达不了的跨字段规则（版本 / 条目唯一、sensitive ⊆ keys、
 * URL 能否解析）只由 zod 判定，单列在下面。
 */
describe("JSON Schema（ajv）与 zod 一致", () => {
  const schema = JSON.parse(
    readFileSync(new URL("../schemas/catalog-index.v1.schema.json", import.meta.url), "utf8"),
  );
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats.default(ajv);
  const validate = ajv.compile(schema);

  const v = (over: Record<string, unknown> = {}) => ({
    version: "0.1.0",
    integrity: SHA,
    minKernel: "0.1.0",
    minSdk: "0.1.0",
    ...over,
  });
  const fixtures: [string, unknown][] = [
    ["合法", index()],
    ["多种 kind", index([pluginEntry(), { ...pluginEntry(), kind: "app", name: "suite" }])],
    ["未知字段（向前兼容）", { ...index(), extra: 1 }],
    [
      "缺 integrity",
      index([pluginEntry({ versions: [{ ...v(), integrity: undefined } as never] })]),
    ],
    ["integrity 不对", index([pluginEntry({ versions: [v({ integrity: "sha512-xx" })] })])],
    ["版本不是 semver", index([pluginEntry({ versions: [v({ version: "1.0" })] })])],
    ["plugin 缺 minSdk", index([pluginEntry({ versions: [v({ minSdk: undefined })] })])],
    ["skill 带 permissions", index([{ ...pluginEntry(), kind: "skill" }])],
    ["名字不合法", index([pluginEntry({ name: "Todo" })])],
    ["npm 名不合法", index([pluginEntry({ npm: "Not A Name" })])],
    ["summary 过长", index([pluginEntry({ summary: { en: "x".repeat(281) } })])],
    ["没有版本", index([pluginEntry({ versions: [] })])],
    ["tarball http", index([pluginEntry({ versions: [v({ tarball: "http://x/y.tgz" })] })])],
    ["schemaVersion 2", { ...index(), schemaVersion: 2 }],
    ["updatedAt 不是时间", { ...index(), updatedAt: "yesterday" }],
    ["name 为空", { ...index(), name: "" }],
    ["kind 未知", index([{ ...pluginEntry(), kind: "theme" }])],
    [
      "policy hook permission key (permissions.hooks.policy:<mount>)",
      index([
        pluginEntry({
          permissions: {
            keys: ["permissions.hooks:model.request", "permissions.hooks.policy:model.request"],
            sensitive: ["permissions.hooks.policy:model.request"],
          },
        }),
      ]),
    ],
    [
      "permission key category with a capital letter",
      index([pluginEntry({ permissions: { keys: ["permissions.policyHooks:x"], sensitive: [] } })]),
    ],
  ];

  for (const [label, json] of fixtures) {
    it(label, () => {
      const clean = JSON.parse(JSON.stringify(json));
      const zodOk = CatalogIndexSchema.safeParse(clean).success;
      expect(validate(clean), JSON.stringify(validate.errors)).toBe(zodOk);
    });
  }

  it("跨字段规则只由 zod 判定（JSON Schema 放行）", () => {
    const dupVersion = index([pluginEntry({ versions: [v(), v()] })]);
    const notSubset = index([
      pluginEntry({ permissions: { keys: ["table:x"], sensitive: ["permissions.secrets"] } }),
    ]);
    for (const json of [dupVersion, notSubset, index([pluginEntry(), pluginEntry()])]) {
      expect(validate(json)).toBe(true);
      expect(CatalogIndexSchema.safeParse(json).success).toBe(false);
    }
  });
});
