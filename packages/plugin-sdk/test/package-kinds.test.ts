import { describe, expect, it } from "vitest";
import {
  ConnectorAuthSchema,
  type ConnectorTemplateSpec,
  defineExtension,
  PACKAGE_KINDS,
  parsePackageSection,
  staticManifestOf,
  validateConnectorTemplate,
} from "../src/index.js";

const pluginPkg = () => {
  const m = staticManifestOf(
    defineExtension({
      name: "demo-plugin",
      version: "1.2.3",
      sdk: "^0.1.0",
      provides: [],
      permissions: {},
      setup() {},
    }),
  );
  return {
    name: "@acme/plugin-demo",
    version: "1.2.3",
    peerDependencies: { "@capybara-hq/plugin-sdk": "^0.1.0" },
    capybara: { kind: "plugin", entry: "dist/index.mjs", sdk: "^0.1.0", manifest: m },
  };
};

const template = (over: Partial<ConnectorTemplateSpec> = {}): ConnectorTemplateSpec => ({
  plugin: "connector-mcp",
  pluginVersion: "^0.1.0",
  connector: "mcp",
  endpoint: { url: "https://mcp.example.com/mcp" },
  editableEndpoint: ["url"],
  auth: { type: "bearer", ownership: "org" },
  defaultToolPolicies: { search: "allow", delete_all: "deny" },
  icon: "icon.svg",
  ...over,
});

const templatePkg = (
  section: Record<string, unknown> = {},
  over: Record<string, unknown> = {},
): Record<string, unknown> => ({
  name: "@acme/github-mcp",
  version: "1.0.0",
  capybara: {
    kind: "connector-template",
    publisher: "Acme",
    description: "GitHub MCP server",
    displayName: { zh: "GitHub", en: "GitHub" },
    template: template(),
    ...section,
  },
  ...over,
});

const skillPkg = (section: Record<string, unknown> = {}, over: Record<string, unknown> = {}) => ({
  name: "pdf-tools",
  version: "0.2.0",
  capybara: { kind: "skill", publisher: "Acme", description: "PDF helpers", ...section },
  ...over,
});

const errorsOf = (r: unknown): string => {
  if (typeof r === "object" && r !== null && "errors" in r) {
    return (r as { errors: string[] }).errors.join("\n");
  }
  return "";
};

describe("PACKAGE_KINDS", () => {
  it("四种", () => {
    expect([...PACKAGE_KINDS]).toEqual(["plugin", "connector-template", "skill", "app"]);
  });
});

describe("parsePackageSection", () => {
  it("plugin：沿用 validatePluginPackageJson，返回 capybara 段", () => {
    const r = parsePackageSection(pluginPkg(), "0.1.0");
    expect(errorsOf(r)).toBe("");
    expect(r).toMatchObject({ kind: "plugin", manifest: { name: "demo-plugin" } });
  });

  it("plugin：不合法时给出插件包的问题", () => {
    const p = { ...pluginPkg(), scripts: { postinstall: "node x" } };
    expect(errorsOf(parsePackageSection(p, "0.1.0"))).toMatch(/scripts\.postinstall/);
  });

  it("connector-template：合法", () => {
    const r = parsePackageSection(templatePkg(), "0.1.0");
    expect(errorsOf(r)).toBe("");
    expect(r).toMatchObject({
      kind: "connector-template",
      publisher: "Acme",
      template: { plugin: "connector-mcp", connector: "mcp" },
    });
  });

  it("skill：合法", () => {
    const r = parsePackageSection(skillPkg(), "0.1.0");
    expect(errorsOf(r)).toBe("");
    expect(r).toEqual({ kind: "skill", publisher: "Acme", description: "PDF helpers" });
  });

  it("app：只认 manifest app.yaml（内容由 T25 解析）", () => {
    const ok = {
      name: "acme-app",
      version: "1.0.0",
      capybara: { kind: "app", manifest: "app.yaml" },
    };
    expect(parsePackageSection(ok, "0.1.0")).toEqual({ kind: "app", manifest: "app.yaml" });
    const bad = { ...ok, capybara: { kind: "app", manifest: "other.yaml" } };
    expect(errorsOf(parsePackageSection(bad, "0.1.0"))).toMatch(/app\.yaml/);
  });

  it("未知 kind、缺 capybara 段、不是对象", () => {
    expect(
      errorsOf(parsePackageSection({ ...skillPkg(), capybara: { kind: "x" } }, "0.1.0")),
    ).toMatch(/capybara\.kind/);
    expect(errorsOf(parsePackageSection({ name: "a", version: "1.0.0" }, "0.1.0"))).toMatch(
      /capybara/,
    );
    expect(errorsOf(parsePackageSection(null, "0.1.0"))).toMatch(/JSON object/);
  });

  it("非插件包同样拒绝安装脚本与依赖字段、要求合法的名字与 semver 版本", () => {
    expect(
      errorsOf(parsePackageSection(skillPkg({}, { scripts: { install: "x" } }), "0.1.0")),
    ).toMatch(/scripts\.install/);
    expect(
      errorsOf(parsePackageSection(skillPkg({}, { dependencies: { a: "1" } }), "0.1.0")),
    ).toMatch(/dependencies/);
    expect(errorsOf(parsePackageSection(skillPkg({}, { version: "v1" }), "0.1.0"))).toMatch(
      /version/,
    );
    expect(errorsOf(parsePackageSection(skillPkg({}, { name: "Bad Name" }), "0.1.0"))).toMatch(
      /name/,
    );
  });

  it("段里的未知字段、缺 publisher / description、displayName 形状", () => {
    expect(errorsOf(parsePackageSection(skillPkg({ entry: "x" }), "0.1.0"))).toMatch(
      /unknown field "entry"/,
    );
    expect(errorsOf(parsePackageSection(skillPkg({ publisher: "" }), "0.1.0"))).toMatch(
      /publisher/,
    );
    expect(errorsOf(parsePackageSection(skillPkg({ description: 1 }), "0.1.0"))).toMatch(
      /description/,
    );
    expect(
      errorsOf(parsePackageSection(skillPkg({ displayName: { zh: "只有中文" } }), "0.1.0")),
    ).toMatch(/displayName/);
  });

  it("connector-template：npm 包名去掉 scope 后须是目录条目名（小写字母、数字、连字符）", () => {
    expect(
      errorsOf(parsePackageSection(templatePkg({}, { name: "@acme/GitHub_MCP" }), "0.1.0")),
    ).toMatch(/name/);
  });

  it("connector-template：模板不合法时带上路径", () => {
    const r = parsePackageSection(templatePkg({ template: { plugin: "connector-mcp" } }), "0.1.0");
    expect(errorsOf(r)).toMatch(/capybara\.template\.connector/);
  });
});

describe("validateConnectorTemplate", () => {
  it("合法", () => {
    expect(validateConnectorTemplate(template())).toEqual([]);
    expect(
      validateConnectorTemplate({
        plugin: "connector-openapi",
        connector: "openapi",
        endpoint: {},
        auth: { type: "none" },
      }),
    ).toEqual([]);
  });

  it("认证预设里夹带凭据（token）被拒：与安装接口的 AuthSchema 同形，strict", () => {
    const auth = { type: "bearer", ownership: "org", token: "s3cr3t" };
    expect(ConnectorAuthSchema.safeParse(auth).success).toBe(false);
    const errs = validateConnectorTemplate({ ...template(), auth }).join("\n");
    expect(errs).toMatch(/auth/);
    expect(errs).toMatch(/token/);
    expect(errs).not.toMatch(/s3cr3t/);
  });

  it("端点预设里任何层级的凭据样式字段被拒（不回显值）", () => {
    for (const endpoint of [
      { url: "https://x.example", token: "abc" },
      { url: "https://x.example", headers: { Authorization: "Bearer abc" } },
      { url: "https://x.example", nested: { client_secret: "abc" } },
      { url: "https://x.example", apiKey: "abc" },
    ]) {
      const errs = validateConnectorTemplate({ ...template(), endpoint }).join("\n");
      expect(errs, JSON.stringify(endpoint)).toMatch(/credential/);
      expect(errs).not.toMatch(/abc/);
    }
  });

  it("缺字段、类型不对、未知字段", () => {
    expect(validateConnectorTemplate(null).join("\n")).toMatch(/object/);
    const errs = validateConnectorTemplate({ plugin: "Bad", endpoint: [], extra: 1 }).join("\n");
    expect(errs).toMatch(/plugin/);
    expect(errs).toMatch(/connector/);
    expect(errs).toMatch(/endpoint/);
    expect(errs).toMatch(/auth/);
    expect(errs).toMatch(/unknown field "extra"/);
  });

  it("pluginVersion 须是 semver 范围", () => {
    expect(validateConnectorTemplate(template({ pluginVersion: "not a range" })).join()).toMatch(
      /pluginVersion/,
    );
  });

  it("editableEndpoint：点路径格式、去重", () => {
    expect(
      validateConnectorTemplate(template({ editableEndpoint: ["url", "url"] })).join(),
    ).toMatch(/duplicate/);
    for (const p of ["", "a..b", ".a", "a b", "__proto__"]) {
      expect(validateConnectorTemplate(template({ editableEndpoint: [p] })).join(), p).toMatch(
        /editableEndpoint/,
      );
    }
  });

  it("editableEndpoint 的路径段不许是凭据样式的键（组织安装时不能借可编辑端点填凭据）", () => {
    for (const p of ["token", "headers.Authorization", "auth.client_secret", "apiKey"]) {
      expect(validateConnectorTemplate(template({ editableEndpoint: [p] })).join(), p).toMatch(
        /credential/,
      );
    }
  });

  it("defaultToolPolicies 的键不许是原型键", () => {
    const policies = JSON.parse('{"__proto__":"allow","constructor":"deny"}');
    const errs = validateConnectorTemplate(template({ defaultToolPolicies: policies })).join();
    expect(errs).toMatch(/__proto__/);
    expect(errs).toMatch(/constructor/);
  });

  it("ownership 与 auth.ownership 不一致、auth none 时给 ownership", () => {
    expect(validateConnectorTemplate(template({ ownership: "personal" })).join()).toMatch(
      /ownership/,
    );
    expect(
      validateConnectorTemplate(template({ auth: { type: "none" }, ownership: "org" })).join(),
    ).toMatch(/ownership/);
    expect(validateConnectorTemplate(template({ ownership: "org" }))).toEqual([]);
  });

  it("defaultToolPolicies 只许 allow / ask / deny", () => {
    expect(
      validateConnectorTemplate(
        template({ defaultToolPolicies: { x: "maybe" as unknown as "allow" } }),
      ).join(),
    ).toMatch(/defaultToolPolicies/);
  });

  it("icon 须是包内 .svg / .png 路径", () => {
    for (const icon of ["../icon.svg", "/abs.svg", "icon.gif"]) {
      expect(validateConnectorTemplate(template({ icon })).join(), icon).toMatch(/icon/);
    }
  });
});
