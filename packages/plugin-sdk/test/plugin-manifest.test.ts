import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import {
  appearanceIssues,
  ConnectorTemplateFileSchema,
  PLUGIN_MANIFEST_FILE,
  PLUGIN_MANIFEST_LIMITS,
  type PluginManifest,
  PluginManifestSchema,
  parseConnectorTemplateFile,
  parsePluginManifest,
  pluginDescription,
  type StaticExtensionManifest,
  validatePluginPackageJsonFor,
} from "../src/index.js";

const staticManifest = (over: Partial<StaticExtensionManifest> = {}): StaticExtensionManifest => ({
  name: "todo",
  version: "1.0.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  requires: [],
  optional: [],
  permissions: {},
  config: { deployment: [], org: [] },
  ...over,
});

const skillsOnly = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  schemaVersion: 1,
  name: "writing-kit",
  version: "1.2.0",
  publisher: "Acme",
  description: "Skills for writers",
  ...over,
});

const withExtension = (
  over: Record<string, unknown> = {},
  ext: Partial<StaticExtensionManifest> = {},
): Record<string, unknown> => ({
  schemaVersion: 1,
  name: "todo",
  version: "1.0.0",
  publisher: "Capybara",
  description: "A todo list",
  extension: {
    entry: "./dist/index.mjs",
    manifest: staticManifest(ext),
    migrations: "./migrations",
    ui: "./ui",
  },
  ...over,
});

const errorsOf = (json: unknown): string[] => {
  const r = parsePluginManifest(json);
  return "errors" in r ? r.errors : [];
};

describe("parsePluginManifest", () => {
  it("names the manifest file", () => {
    expect(PLUGIN_MANIFEST_FILE).toBe(".capybara-plugin/plugin.json");
  });

  it("a minimal skills-only manifest parses", () => {
    const r = parsePluginManifest(skillsOnly());
    expect("errors" in r).toBe(false);
    expect((r as PluginManifest).name).toBe("writing-kit");
  });

  it("a full declarative manifest parses", () => {
    const m = skillsOnly({
      displayName: { zh: "写作工具", en: "Writing kit" },
      icon: "./assets/icon.svg",
      license: "MIT",
      homepage: "https://example.com/writing-kit",
      dependencies: [{ name: "todo", version: "^1.0.0" }],
      skills: [{ path: "./skills/outline", pinned: true }, { path: "./skills/edit" }],
      connectorTemplates: [{ path: "./connectors/crm.json" }],
      agents: [],
    });
    expect(errorsOf(m)).toEqual([]);
  });

  it("description is a string (en) or { en, zh? }", () => {
    expect(errorsOf(skillsOnly({ description: { en: "Skills for writers" } }))).toEqual([]);
    expect(
      errorsOf(skillsOnly({ description: { en: "Skills for writers", zh: "写作技能" } })),
    ).toEqual([]);
    expect(errorsOf(skillsOnly({ description: { zh: "写作技能" } }))[0]).toMatch(/^description/);
    expect(errorsOf(skillsOnly({ description: { en: "x", fr: "y" } }))[0]).toMatch(/fr/);
    expect(errorsOf(skillsOnly({ description: { en: "x", zh: " " } }))[0]).toMatch(
      /^description\.zh: /,
    );
    expect(pluginDescription("Skills")).toEqual({ en: "Skills" });
    expect(pluginDescription({ en: "Skills", zh: "技能" })).toEqual({ en: "Skills", zh: "技能" });
  });

  it("an extension-bearing manifest parses", () => {
    const r = parsePluginManifest(withExtension());
    expect(errorsOf(withExtension())).toEqual([]);
    expect((r as PluginManifest).extension?.manifest.name).toBe("todo");
  });

  it("accepts $schema", () => {
    expect(
      errorsOf(skillsOnly({ $schema: "https://capybarahq.com/schemas/plugin.v1.schema.json" })),
    ).toEqual([]);
  });

  it("accepts the file text and rejects invalid JSON or oversized text", () => {
    expect(errorsOf(JSON.stringify(skillsOnly()))).toEqual([]);
    expect(errorsOf("{ not json")[0]).toMatch(/not valid JSON/);
    expect(errorsOf(" ".repeat(PLUGIN_MANIFEST_LIMITS.manifestChars + 1))[0]).toMatch(
      /larger than/,
    );
    expect(errorsOf([])).toEqual(["plugin.json must be a JSON object"]);
  });

  const rejects: [string, Record<string, unknown>, RegExp][] = [
    ["name", skillsOnly({ name: "Writing" }), /^name: /],
    ["version", skillsOnly({ version: "1.2" }), /^version: .*semver/],
    ["version range", skillsOnly({ version: "^1.2.0" }), /^version: /],
    ["schemaVersion", skillsOnly({ schemaVersion: 2 }), /^schemaVersion: /],
    ["publisher", skillsOnly({ publisher: " " }), /^publisher: /],
    ["description length", skillsOnly({ description: "x".repeat(1025) }), /^description: /],
    ["unknown key", skillsOnly({ extra: 1 }), /extra/],
    ["homepage http", skillsOnly({ homepage: "http://example.com" }), /^homepage: .*https/],
    ["unsafe skill path", skillsOnly({ skills: [{ path: "./../x" }] }), /^skills\.0\.path: /],
    ["skill path without ./", skillsOnly({ skills: [{ path: "skills/x" }] }), /^skills\.0\.path/],
    ["unsafe icon", skillsOnly({ icon: "../x.svg" }), /^icon: /],
    ["icon type", skillsOnly({ icon: "./icon.gif" }), /^icon: .*svg/],
    [
      "nested skill paths",
      skillsOnly({ skills: [{ path: "./skills/a" }, { path: "./skills/a/b" }] }),
      /^skills\.1\.path: .*inside another skill/,
    ],
    [
      "duplicate skill path",
      skillsOnly({ skills: [{ path: "./skills/a" }, { path: "./skills/a" }] }),
      /^skills\.1\.path: duplicate/,
    ],
    [
      "connector template not .json",
      skillsOnly({ connectorTemplates: [{ path: "./connectors/crm.yaml" }] }),
      /^connectorTemplates\.0\.path: /,
    ],
    [
      "connector template id",
      skillsOnly({ connectorTemplates: [{ path: "./connectors/CRM.json" }] }),
      /^connectorTemplates\.0\.path: /,
    ],
    [
      "duplicate connector template id",
      skillsOnly({
        connectorTemplates: [{ path: "./connectors/crm.json" }, { path: "./more/crm.json" }],
      }),
      /^connectorTemplates\.1\.path: duplicate connector template id crm/,
    ],
    [
      "duplicate dependency",
      skillsOnly({
        dependencies: [
          { name: "todo", version: "^1.0.0" },
          { name: "todo", version: "^2.0.0" },
        ],
      }),
      /^dependencies\.1\.name: duplicate dependency todo/,
    ],
    [
      "self-dependency",
      skillsOnly({ dependencies: [{ name: "writing-kit", version: "^1.0.0" }] }),
      /^dependencies\.0\.name: .*itself/,
    ],
    [
      "dependency range",
      skillsOnly({ dependencies: [{ name: "todo", version: "not a range" }] }),
      /^dependencies\.0\.version: /,
    ],
    [
      "agent path outside the plugin",
      skillsOnly({ agents: [{ path: "./../agents/a.md" }] }),
      /^agents\.0\.path: /,
    ],
    [
      "agent path not a .md file",
      skillsOnly({ agents: [{ path: "./agents/a.json" }] }),
      /^agents\.0\.path: .*\.md/,
    ],
    [
      "duplicate agent path",
      skillsOnly({ agents: [{ path: "./agents/a.md" }, { path: "./agents/a.md" }] }),
      /^agents\.1\.path: duplicate agent template path/,
    ],
    [
      "more than 64 agents",
      skillsOnly({
        agents: Array.from({ length: 65 }, (_, i) => ({ path: `./agents/a${i}.md` })),
      }),
      /^agents: /,
    ],
    [
      "nothing in it",
      skillsOnly({ skills: [], connectorTemplates: [] }),
      /a plugin must contain an extension, a skill, a connector template, an agent template or a theme/,
    ],
    [
      "extension name ≠ plugin name",
      withExtension({}, { name: "other" }),
      /^extension\.manifest\.name: /,
    ],
    [
      "extension version ≠ plugin version",
      withExtension({}, { version: "1.0.1" }),
      /^extension\.manifest\.version: .*1\.0\.0/,
    ],
    [
      "plugin with an extension needs an extension name",
      withExtension({ name: "9todo" }, { name: "9todo" }),
      /^name: .*extension name/,
    ],
    [
      "extension sdk without upper bound",
      withExtension({}, { sdk: ">=0.1.0" }),
      /^extension\.manifest\.sdk: .*upper bound/,
    ],
    [
      "extension entry not .mjs",
      withExtension({
        extension: { entry: "./dist/index.js", manifest: staticManifest() },
      }),
      /^extension\.entry: /,
    ],
    [
      "extension unknown key",
      withExtension({
        extension: { entry: "./dist/index.mjs", manifest: staticManifest(), extra: 1 },
      }),
      /extra/,
    ],
    [
      "extension manifest rules (defineExtension)",
      withExtension({}, { provides: ["nope@1"] }),
      /^extension\.manifest: .*unregistered extension point/,
    ],
  ];
  for (const [label, json, re] of rejects) {
    it(`rejects: ${label}`, () => {
      const errs = errorsOf(json);
      expect(
        errs.some((e) => re.test(e)),
        errs.join("\n"),
      ).toBe(true);
    });
  }

  it("plugin manifest accepts agents refs and rejects a path outside the plugin", () => {
    const m = skillsOnly({
      skills: [],
      agents: [{ path: "./agents/code-reviewer.md" }, { path: "./more/planner.md" }],
    });
    expect(parsePluginManifest(m)).toEqual(m);
    expect(errorsOf(skillsOnly({ agents: [{ path: "/etc/agents/a.md" }] }))[0]).toMatch(
      /^agents\.0\.path: /,
    );
    expect(PLUGIN_MANIFEST_LIMITS.agents).toBe(64);
  });

  it("more than 64 agents is rejected", () => {
    const refs = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ path: `./agents/a${i}.md` }));
    expect(parsePluginManifest(skillsOnly({ agents: refs(64) }))).not.toHaveProperty("errors");
    expect(errorsOf(skillsOnly({ agents: refs(65) }))[0]).toMatch(/^agents: /);
  });

  it("a plugin of themes only carries something; at most 10 themes, unique ids", () => {
    const refs = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ path: `./themes/t${i}.json` }));
    const themesOnly = skillsOnly({ skills: [], connectorTemplates: [], themes: refs(1) });
    expect(errorsOf(themesOnly)).toEqual([]);
    expect(
      errorsOf(skillsOnly({ skills: [], connectorTemplates: [], themes: [] })).join("\n"),
    ).toMatch(/or a theme/);
    expect(PLUGIN_MANIFEST_LIMITS.themes).toBe(10);
    expect(errorsOf(skillsOnly({ themes: refs(10) }))).toEqual([]);
    expect(errorsOf(skillsOnly({ themes: refs(11) }))[0]).toMatch(/^themes: /);
    expect(errorsOf(skillsOnly({ themes: [{ path: "./themes/Bad.json" }] }))[0]).toMatch(
      /^themes\.0\.path: /,
    );
    expect(errorsOf(skillsOnly({ themes: [{ path: "./themes/a.md" }] }))[0]).toMatch(
      /^themes\.0\.path: /,
    );
    expect(
      errorsOf(skillsOnly({ themes: [{ path: "./themes/a.json" }, { path: "./x/a.json" }] }))[0],
    ).toMatch(/^themes\.1\.path: duplicate theme id a/);
  });

  it("caps errors at 50 and never throws", () => {
    const m = skillsOnly({
      skills: Array.from({ length: 50 }, () => ({ path: "../x" })),
      connectorTemplates: Array.from({ length: 20 }, () => ({ path: "../x" })),
    });
    expect(errorsOf(m)).toHaveLength(50);
    expect(() => parsePluginManifest(undefined)).not.toThrow();
    expect(() => parsePluginManifest(withExtension({ extension: 1 }))).not.toThrow();
  });
});

describe("parseConnectorTemplateFile", () => {
  const file = (template: Record<string, unknown> = {}) => ({
    displayName: { zh: "CRM", en: "CRM" },
    description: "The CRM server",
    icon: "./assets/crm.svg",
    template: {
      plugin: "connector-mcp",
      connector: "mcp",
      endpoint: { url: "https://crm.example.com/mcp" },
      editableEndpoint: ["url"],
      auth: { type: "bearer", ownership: "org" },
      ...template,
    },
  });

  it("a valid file parses", () => {
    const r = parseConnectorTemplateFile(file());
    expect("errors" in r ? r.errors : []).toEqual([]);
  });

  it("rejects a credential key in endpoint (validateConnectorTemplate)", () => {
    const r = parseConnectorTemplateFile(
      file({ endpoint: { url: "https://x.example.com", apiKey: "s3cr3t" } }),
    );
    const errs = "errors" in r ? r.errors : [];
    expect(errs.join("\n")).toMatch(/template\.endpoint\.apiKey looks like a credential/);
    expect(errs.join("\n")).not.toContain("s3cr3t");
  });

  it("rejects unknown keys and a missing displayName", () => {
    const r = parseConnectorTemplateFile({ ...file(), extra: 1, displayName: undefined });
    const errs = "errors" in r ? r.errors : [];
    expect(errs.join("\n")).toMatch(/extra/);
    expect(errs.join("\n")).toMatch(/displayName/);
  });

  it("accepts the file text", () => {
    const r = parseConnectorTemplateFile(JSON.stringify(file()));
    expect("errors" in r ? r.errors : []).toEqual([]);
  });

  it("defaultEnabled is an optional boolean", () => {
    const off = parseConnectorTemplateFile({ ...file(), defaultEnabled: false });
    expect("errors" in off ? off.errors : off.defaultEnabled).toBe(false);
    const bad = parseConnectorTemplateFile({ ...file(), defaultEnabled: "no" });
    expect("errors" in bad ? bad.errors.join("\n") : "").toMatch(/defaultEnabled/);
  });

  it("an OAuth auth preset may list more bearer token types (tokenTypes)", () => {
    const oauth = (tokenTypes: unknown) =>
      file({
        auth: {
          type: "oauth_code",
          ownership: "personal",
          discovery: "mcp",
          client: "manual",
          tokenTypes,
        },
      });
    const ok = parseConnectorTemplateFile(oauth(["user", "N_A.v2"]));
    expect("errors" in ok ? ok.errors : []).toEqual([]);
    // DPoP binds the token to a key the kernel does not hold: never a bearer token
    for (const bad of [
      ["bad type"],
      [""],
      Array(6).fill("x"),
      "user",
      ["DPoP"],
      ["dpop"],
      ["DPOP"],
    ]) {
      const r = parseConnectorTemplateFile(oauth(bad));
      expect("errors" in r ? r.errors : [], JSON.stringify(bad)).not.toEqual([]);
    }
  });
});

describe("validatePluginPackageJsonFor", () => {
  const HOST = "0.1.0";
  const ext = parsePluginManifest(withExtension()) as PluginManifest;
  const decl = parsePluginManifest(skillsOnly()) as PluginManifest;
  const extPkg = (over: Record<string, unknown> = {}) => ({
    name: "@capybara-hq/plugin-todo",
    version: "1.0.0",
    peerDependencies: { "@capybara-hq/plugin-sdk": "^0.1.0-rc.0", zod: "^4.0.0" },
    ...over,
  });
  const declPkg = (over: Record<string, unknown> = {}) => ({
    name: "@acme/writing-kit",
    version: "1.2.0",
    ...over,
  });

  it("valid packages pass", () => {
    expect(validatePluginPackageJsonFor(extPkg(), ext, HOST, { hostZodVersion: "4.6.7" })).toEqual(
      [],
    );
    expect(validatePluginPackageJsonFor(declPkg(), decl, HOST)).toEqual([]);
  });

  it("rejects a capybara section", () => {
    expect(
      validatePluginPackageJsonFor(declPkg({ capybara: { kind: "skill" } }), decl, HOST),
    ).toEqual([
      "package.json must not have a capybara section (the manifest is .capybara-plugin/plugin.json)",
    ]);
  });

  it("rejects a version mismatch", () => {
    expect(validatePluginPackageJsonFor(declPkg({ version: "1.2.1" }), decl, HOST)).toEqual([
      'package.json version "1.2.1" does not match plugin.json version "1.2.0"',
    ]);
  });

  it("rejects peerDependencies on a declarative plugin", () => {
    const errs = validatePluginPackageJsonFor(
      declPkg({ peerDependencies: { zod: "^4.0.0" } }),
      decl,
      HOST,
    );
    expect(errs.join("\n")).toMatch(
      /peerDependencies is not allowed in a plugin without an extension/,
    );
  });

  it("accepts main / exports naming the extension entry, so the package resolves by name", () => {
    const entry = ext.extension?.entry as string;
    for (const over of [
      { main: entry },
      { exports: entry },
      { exports: { ".": entry } },
      { main: entry, exports: { ".": entry } },
      // main with or without the leading ./ (exports targets must start with ./ for Node)
      { main: entry.replace(/^\.\//, ""), exports: { ".": entry } },
    ]) {
      expect(validatePluginPackageJsonFor(extPkg(over), ext, HOST)).toEqual([]);
    }
  });

  it("rejects main / exports pointing anywhere else", () => {
    for (const over of [
      { main: "./dist/other.mjs" },
      { exports: "./src/index.ts" },
      { exports: { ".": "./dist/index.mjs", "./x": "./x.mjs" } },
      { exports: { ".": { import: "./dist/index.mjs" } } },
      { exports: "dist/index.mjs" },
    ]) {
      expect(validatePluginPackageJsonFor(extPkg(over), ext, HOST).join("\n")).toMatch(
        /package\.json (main|exports) must be absent or name the extension entry/,
      );
    }
  });

  it("rejects main / exports on a declarative plugin (nothing to load)", () => {
    for (const over of [{ main: "./index.js" }, { exports: { ".": "./index.js" } }]) {
      expect(validatePluginPackageJsonFor(declPkg(over), decl, HOST).join("\n")).toMatch(
        /package\.json (main|exports) is not allowed in a plugin without an extension/,
      );
    }
  });

  it("rejects an extension sdk range that differs from the peer range", () => {
    const errs = validatePluginPackageJsonFor(
      extPkg({ peerDependencies: { "@capybara-hq/plugin-sdk": "^0.2.0" } }),
      ext,
      HOST,
    );
    expect(errs.join("\n")).toMatch(
      /peerDependencies "@capybara-hq\/plugin-sdk" "\^0\.2\.0" must equal extension\.manifest\.sdk "\^0\.1\.0-rc\.0"/,
    );
  });

  it("requires the sdk peer for a plugin with an extension, and a host that satisfies it", () => {
    expect(
      validatePluginPackageJsonFor(extPkg({ peerDependencies: {} }), ext, HOST).join("\n"),
    ).toMatch(/is required and must equal extension\.manifest\.sdk/);
    expect(validatePluginPackageJsonFor(extPkg(), ext, "0.2.0").join("\n")).toMatch(
      /not satisfied by the host SDK version 0\.2\.0/,
    );
  });

  it("keeps the common package.json rules", () => {
    const errs = validatePluginPackageJsonFor(
      declPkg({
        name: "Not A Name",
        scripts: { postinstall: "x" },
        gypfile: true,
        dependencies: { lodash: "^4" },
      }),
      decl,
      HOST,
    );
    expect(errs).toEqual([
      "package.json name must be a valid npm package name",
      "package.json scripts.postinstall is not allowed: plugin packages never run scripts",
      "package.json gypfile is not allowed: native addons are not supported",
      "package.json dependencies is not allowed: bundle third-party dependencies into the entry",
    ]);
    expect(
      validatePluginPackageJsonFor(
        extPkg({ peerDependencies: { "@capybara-hq/plugin-sdk": "^0.1.0-rc.0", lodash: "^4" } }),
        ext,
        HOST,
      ).join("\n"),
    ).toMatch(/peerDependencies "lodash" is not provided by the host/);
    expect(
      validatePluginPackageJsonFor(extPkg(), ext, HOST, { hostZodVersion: "3.25.0" }).join("\n"),
    ).toMatch(/zod "\^4\.0\.0" is not satisfied by the host zod 3\.25\.0/);
  });
});

describe("JSON Schema (ajv) agrees with zod", () => {
  const ajvFor = (file: string) => {
    const schema = JSON.parse(readFileSync(new URL(`../schemas/${file}`, import.meta.url), "utf8"));
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats.default(ajv);
    return ajv.compile(schema);
  };

  const plugin = ajvFor("plugin.v1.schema.json");
  const pluginFixtures: [string, unknown][] = [
    ["skills only", skillsOnly()],
    ["with extension", withExtension()],
    ["$schema", skillsOnly({ $schema: "./x.json" })],
    ["unknown key", skillsOnly({ extra: 1 })],
    [
      "extension unknown key",
      withExtension({ extension: { entry: "./dist/index.mjs", manifest: staticManifest(), x: 1 } }),
    ],
    ["bad name", skillsOnly({ name: "Bad" })],
    ["bad version", skillsOnly({ version: "1" })],
    ["agents without a path", skillsOnly({ agents: [{}] })],
    ["agents", skillsOnly({ agents: [{ path: "./agents/a.md" }] })],
    ["agent path not .md", skillsOnly({ agents: [{ path: "./agents/a.json" }] })],
    ["themes", skillsOnly({ themes: [{ path: "./themes/a.json" }] })],
    ["theme without a path", skillsOnly({ themes: [{}] })],
    ["homepage http", skillsOnly({ homepage: "http://x.example.com" })],
    ["missing publisher", { ...skillsOnly(), publisher: undefined }],
    ["localized description", skillsOnly({ description: { en: "Skills", zh: "技能" } })],
    ["description without en", skillsOnly({ description: { zh: "技能" } })],
    ["description unknown language", skillsOnly({ description: { en: "x", fr: "y" } })],
  ];
  for (const [label, json] of pluginFixtures) {
    it(`plugin.v1: ${label}`, () => {
      const clean = JSON.parse(JSON.stringify(json));
      expect(plugin(clean), JSON.stringify(plugin.errors)).toBe(
        PluginManifestSchema.safeParse(clean).success,
      );
    });
  }

  it("plugin.v1: cross-field rules are only zod's (JSON Schema lets them through)", () => {
    for (const json of [
      withExtension({}, { name: "other" }),
      skillsOnly({ dependencies: [{ name: "writing-kit", version: "^1.0.0" }] }),
      skillsOnly({ skills: [{ path: "./skills/a" }, { path: "./skills/a/b" }] }),
    ]) {
      expect(plugin(json)).toBe(true);
      expect(PluginManifestSchema.safeParse(json).success).toBe(false);
    }
  });

  const template = ajvFor("connector-template.v1.schema.json");
  it("connector-template.v1 agrees", () => {
    const ok = {
      displayName: { zh: "a", en: "a" },
      template: { plugin: "connector-mcp", connector: "mcp", endpoint: {}, auth: { type: "none" } },
    };
    for (const json of [
      ok,
      { ...ok, extra: 1 },
      { ...ok, displayName: { zh: "a" } },
      { ...ok, defaultEnabled: false },
      { ...ok, defaultEnabled: "no" },
    ]) {
      expect(template(json)).toBe(ConnectorTemplateFileSchema.safeParse(json).success);
    }
  });
});

describe("client section and suggestedAppearance", () => {
  const sri = `sha384-${"A".repeat(64)}`;
  const ENTRY = "./dist/client/client.mjs";
  const clientSection = { entry: ENTRY, integrity: { [ENTRY]: sri }, apiVersion: 1 };
  const comp = (slot: string, id = "brand") => ({
    id,
    title: { zh: "品牌", en: "Brand" },
    slot,
    kind: "component" as const,
  });
  const withClient = (
    over: Record<string, unknown> = {},
    ext: Partial<StaticExtensionManifest> = {},
    section: Record<string, unknown> | null = clientSection,
  ) => {
    const base = withExtension(over, {
      permissions: { client: true, ui: { components: ["brand"] } },
      ui: [comp("shell.brand")],
      ...ext,
    });
    if (section !== null) (base.extension as Record<string, unknown>).client = section;
    return base;
  };

  it("client needs permissions.client and the reverse", () => {
    expect(errorsOf(withClient())).toEqual([]);
    expect(errorsOf(withExtension({ extension: undefined }))).not.toContain("x");
    const noPerm = withExtension();
    (noPerm.extension as Record<string, unknown>).client = clientSection;
    expect(errorsOf(noPerm)).toContain(
      "extension.client: extension.client needs permissions.client: true",
    );
    expect(
      errorsOf(withClient({}, { ui: undefined, permissions: { client: true } }, null)).some((e) =>
        e.includes("extension.client needs permissions.client: true"),
      ),
    ).toBe(true);
  });

  it("a bad client section is reported", () => {
    const bad = withClient({}, {}, { ...clientSection, integrity: {} });
    expect(errorsOf(bad).some((e) => e.includes("client.integrity: missing entry"))).toBe(true);
  });

  it("suggestedAppearance needs theme or replacements", () => {
    expect(errorsOf(withClient({ suggestedAppearance: {} }))).toContain(
      "suggestedAppearance: suggestedAppearance needs theme or replacements",
    );
  });

  it("a replacement in a list slot is refused", () => {
    const m = withClient(
      { suggestedAppearance: { replacements: { "shell.overlay": "brand" } } },
      { ui: [comp("shell.overlay")] },
    );
    expect(errorsOf(m).join("\n")).toContain("shell.overlay is not a replaceable slot");
  });

  it("a replacement naming a view is refused", () => {
    const m = withClient(
      { suggestedAppearance: { replacements: { "shell.brand": "brand" } } },
      {
        permissions: { client: true, ui: { views: ["brand"] } },
        ui: [
          {
            id: "brand",
            title: { zh: "品牌", en: "Brand" },
            slot: "org.page",
            kind: "view" as const,
          },
        ],
      },
    );
    expect(errorsOf(m).join("\n")).toContain(
      "shell.brand names brand, which is not a component contribution in that slot",
    );
  });

  it("a replacement in an unknown slot is accepted", () => {
    const m = withClient({ suggestedAppearance: { replacements: { "future.slot": "brand" } } });
    expect(errorsOf(m)).toEqual([]);
  });

  it("a valid replacement and theme parse; replacements need an extension", () => {
    expect(
      errorsOf(withClient({ suggestedAppearance: { replacements: { "shell.brand": "brand" } } })),
    ).toEqual([]);
    expect(
      errorsOf(
        skillsOnly({ suggestedAppearance: { replacements: { "shell.brand": "brand" } } }),
      ).join("\n"),
    ).toContain("needs an extension");
  });

  it("nine replacements are refused", () => {
    const replacements = Object.fromEntries(
      Array.from({ length: 9 }, (_, i) => [`future.slot${i}`, "brand"]),
    );
    expect(errorsOf(withClient({ suggestedAppearance: { replacements } })).join("\n")).toContain(
      "9 entries",
    );
  });

  it("a listed theme the plugin does not carry is refused", () => {
    const m = skillsOnly({
      themes: [{ path: "./themes/neon.json" }],
      suggestedAppearance: { theme: "other" },
    });
    expect(errorsOf(m).join("\n")).toContain("suggestedAppearance.theme names other");
  });

  it("appearanceIssues refuses a theme the plugin does not carry", () => {
    const m = parsePluginManifest(
      skillsOnly({ suggestedAppearance: { theme: "neon" } }),
    ) as PluginManifest;
    expect(appearanceIssues(m, ["neon"])).toEqual([]);
    expect(appearanceIssues(m, ["other"])).toEqual([
      "suggestedAppearance.theme names neon, which is not a theme of the plugin",
    ]);
  });
});
