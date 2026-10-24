import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import {
  APP_MANIFEST_FILE,
  APP_MANIFEST_LIMITS,
  type AppManifest,
  AppManifestSchema,
  parseAppManifest,
} from "../src/index.js";

const SHA = `sha512-${"A".repeat(86)}==`;

const manifest = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  schemaVersion: 1,
  name: "crm-suite",
  version: "1.0.0",
  publisher: "Acme",
  description: "CRM tools for sales teams",
  displayName: { zh: "CRM 套件", en: "CRM Suite" },
  plugins: [
    {
      name: "todo",
      npm: "@capybara-hq/plugin-todo",
      version: "^0.1.0",
      lock: { version: "0.1.0", integrity: SHA },
    },
    {
      name: "connector-mcp",
      npm: "@capybara-hq/plugin-connector-mcp",
      version: "~0.1.0",
      lock: { version: "0.1.2", integrity: SHA },
      optional: true,
    },
  ],
  connectorTemplates: [
    {
      id: "crm-mcp",
      displayName: { zh: "CRM", en: "CRM" },
      template: {
        plugin: "connector-mcp",
        connector: "mcp",
        endpoint: { url: "https://crm.example.com/mcp" },
        editableEndpoint: ["url"],
        auth: { type: "bearer", ownership: "org" },
      },
    },
  ],
  skills: [{ path: "skills/crm-notes" }],
  ...over,
});

const yamlOf = (m: unknown) => stringify(m);
const errorsOf = (m: unknown, opts?: Parameters<typeof parseAppManifest>[1]): string[] => {
  const r = parseAppManifest(typeof m === "string" ? m : yamlOf(m), opts);
  return "errors" in r ? r.errors : [];
};

describe("parseAppManifest", () => {
  it("合法清单通过，返回解析结果", () => {
    expect(APP_MANIFEST_FILE).toBe("app.yaml");
    const r = parseAppManifest(yamlOf(manifest()));
    expect("errors" in r, JSON.stringify(r)).toBe(false);
    const m = r as AppManifest;
    expect(m.name).toBe("crm-suite");
    expect(m.plugins.map((p) => p.name)).toEqual(["todo", "connector-mcp"]);
    expect(m.connectorTemplates[0]?.template.plugin).toBe("connector-mcp");
    expect(m.skills).toEqual([{ path: "skills/crm-notes" }]);
  });

  it("lock.version 不满足 version 范围", () => {
    const m = manifest();
    (m.plugins as Record<string, unknown>[])[0] = {
      name: "todo",
      npm: "@capybara-hq/plugin-todo",
      version: "^0.2.0",
      lock: { version: "0.1.0", integrity: SHA },
    };
    expect(errorsOf(m).join("\n")).toMatch(/plugins\.0\.lock\.version.*does not satisfy/);
  });

  it("version 不是合法的 semver 范围", () => {
    const m = manifest();
    (m.plugins as Record<string, unknown>[])[0] = {
      ...(m.plugins as Record<string, unknown>[])[0],
      version: "not a range",
    };
    expect(errorsOf(m).join("\n")).toMatch(/plugins\.0\.version/);
  });

  it("模板引用了未列出的插件；给出已知连接器插件时可以引用它", () => {
    const m = manifest({ plugins: [(manifest().plugins as unknown[])[0]] });
    expect(errorsOf(m).join("\n")).toMatch(
      /connectorTemplates\.0\.template\.plugin.*connector-mcp.*not listed in plugins/,
    );
    expect(errorsOf(m, { isKnownConnectorPlugin: (n) => n === "connector-mcp" })).toEqual([]);
  });

  it("模板的 pluginVersion 不被 lock 版本满足", () => {
    const m = manifest();
    const t = (m.connectorTemplates as { template: Record<string, unknown> }[])[0];
    if (t) t.template.pluginVersion = "^1.0.0";
    expect(errorsOf(m).join("\n")).toMatch(/pluginVersion/);
  });

  it("模板 id 重复、插件名重复", () => {
    const t = (manifest().connectorTemplates as unknown[])[0];
    expect(errorsOf(manifest({ connectorTemplates: [t, t] })).join("\n")).toMatch(
      /duplicate connector template id crm-mcp/,
    );
    const p = (manifest().plugins as unknown[])[0];
    expect(errorsOf(manifest({ plugins: [p, p] })).join("\n")).toMatch(/duplicate plugin todo/);
  });

  it("技能路径越界 / 绝对路径 / 重复 / 互相嵌套", () => {
    for (const path of ["../outside", "/etc/skills", "skills/../../x", "a\\b", ""]) {
      expect(errorsOf(manifest({ skills: [{ path }] })).join("\n"), path).toMatch(
        /skills\.0\.path/,
      );
    }
    expect(
      errorsOf(manifest({ skills: [{ path: "skills/a" }, { path: "skills/a" }] })).join("\n"),
    ).toMatch(/duplicate skill path/);
    expect(
      errorsOf(manifest({ skills: [{ path: "skills" }, { path: "skills/a" }] })).join("\n"),
    ).toMatch(/inside another skill/);
  });

  it("模板不许带凭据（复用 validateConnectorTemplate）", () => {
    const m = manifest();
    const t = (m.connectorTemplates as { template: Record<string, unknown> }[])[0];
    if (t) t.template.endpoint = { url: "https://x.example.com", headers: { Authorization: "x" } };
    expect(errorsOf(m).join("\n")).toMatch(/looks like a credential/);
  });

  it("超过数量上限", () => {
    const plugins = Array.from({ length: APP_MANIFEST_LIMITS.plugins + 1 }, (_, i) => ({
      name: `p${String(i).padStart(2, "0")}`,
      npm: `@acme/p${i}`,
      version: "^1.0.0",
      lock: { version: "1.0.0", integrity: SHA },
    }));
    expect(errorsOf(manifest({ plugins, connectorTemplates: [] })).join("\n")).toMatch(/plugins/);
    const skills = Array.from({ length: APP_MANIFEST_LIMITS.skills + 1 }, (_, i) => ({
      path: `skills/s${i}`,
    }));
    expect(errorsOf(manifest({ skills })).join("\n")).toMatch(/skills/);
  });

  it("未知字段、integrity 格式、名字、schemaVersion", () => {
    expect(errorsOf(manifest({ extra: 1 })).join("\n")).toMatch(/extra/);
    const m = manifest();
    (m.plugins as Record<string, unknown>[])[0] = {
      ...(m.plugins as Record<string, unknown>[])[0],
      lock: { version: "0.1.0", integrity: "sha256-abc" },
    };
    expect(errorsOf(m).join("\n")).toMatch(/integrity/);
    expect(errorsOf(manifest({ name: "CRM" })).join("\n")).toMatch(/name/);
    expect(errorsOf(manifest({ schemaVersion: 2 })).join("\n")).toMatch(/schemaVersion/);
    expect(errorsOf(manifest({ description: "x".repeat(1025) })).join("\n")).toMatch(/description/);
  });

  it("YAML 本身不合法 / 不是映射 / 重复键 / 过大", () => {
    expect(errorsOf("a: [").join("\n")).toMatch(/not valid YAML/);
    expect(errorsOf("- 1\n- 2\n").join("\n")).toMatch(/mapping/);
    expect(errorsOf("name: a\nname: b\n").join("\n")).toMatch(/not valid YAML/);
    expect(errorsOf(`# ${"x".repeat(APP_MANIFEST_LIMITS.manifestChars)}\n`).join("\n")).toMatch(
      /larger than/,
    );
  });

  it("别名炸弹被拒（maxAliasCount）", () => {
    const bomb = [
      "a: &a [x, x, x, x, x, x, x, x, x, x]",
      "b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]",
      "c: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]",
      "d: &d [*c, *c, *c, *c, *c, *c, *c, *c, *c, *c]",
      "e: [*d, *d, *d, *d, *d, *d, *d, *d, *d, *d]",
    ].join("\n");
    expect(errorsOf(bomb).join("\n")).toMatch(/not valid YAML.*[Aa]lias/);
  });
});

describe("JSON Schema（ajv）与 zod 一致", () => {
  const schema = JSON.parse(
    readFileSync(new URL("../schemas/app.v1.schema.json", import.meta.url), "utf8"),
  );
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats.default(ajv);
  const validate = ajv.compile(schema);
  const plugin0 = (over: Record<string, unknown> = {}) => ({
    ...(manifest().plugins as Record<string, unknown>[])[0],
    ...over,
  });

  const fixtures: [string, unknown][] = [
    ["合法", manifest()],
    ["最小（没有模板与技能）", manifest({ connectorTemplates: [], skills: [] })],
    ["未知字段", manifest({ extra: 1 })],
    ["插件条目未知字段", manifest({ plugins: [plugin0({ foo: 1 })], connectorTemplates: [] })],
    ["schemaVersion 2", manifest({ schemaVersion: 2 })],
    ["名字不合法", manifest({ name: "CRM" })],
    ["版本不是 semver", manifest({ version: "1.0" })],
    ["description 过长", manifest({ description: "x".repeat(1025) })],
    ["缺 publisher", { ...manifest(), publisher: undefined }],
    [
      "integrity 不对",
      manifest({ plugins: [plugin0({ lock: { version: "0.1.0", integrity: "sha512-x" } })] }),
    ],
    [
      "lock.version 不是 semver",
      manifest({ plugins: [plugin0({ lock: { version: "0.1", integrity: SHA } })] }),
    ],
    ["插件名不合法", manifest({ plugins: [plugin0({ name: "Todo" })] })],
    ["npm 名不合法", manifest({ plugins: [plugin0({ npm: "Not A Name" })] })],
    [
      "插件过多",
      manifest({
        plugins: Array.from({ length: 21 }, (_, i) =>
          plugin0({ name: `p${String(i).padStart(2, "0")}`, npm: `@a/p${i}` }),
        ),
        connectorTemplates: [],
      }),
    ],
    [
      "模板 id 不合法",
      manifest({
        connectorTemplates: [{ id: "X", displayName: { zh: "a", en: "a" }, template: {} }],
      }),
    ],
    ["技能缺 path", manifest({ skills: [{}] })],
    ["displayName 缺 en", manifest({ displayName: { zh: "a" } })],
  ];

  for (const [label, json] of fixtures) {
    it(label, () => {
      const clean = JSON.parse(JSON.stringify(json));
      const zodOk = AppManifestSchema.safeParse(clean).success;
      expect(validate(clean), JSON.stringify(validate.errors)).toBe(zodOk);
    });
  }

  it("跨字段规则只由 zod 判定（JSON Schema 放行）", () => {
    const notSatisfied = manifest({
      plugins: [plugin0({ version: "^0.2.0" }), (manifest().plugins as unknown[])[1]],
    });
    const unlisted = manifest({ plugins: [plugin0()] });
    const traversal = manifest({ skills: [{ path: "../x" }] });
    for (const json of [notSatisfied, unlisted, traversal]) {
      expect(validate(json)).toBe(true);
      expect(AppManifestSchema.safeParse(json).success).toBe(false);
    }
  });
});
