import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import {
  type PluginSetupGuide,
  parsePluginManifest,
  renderSetupGuideText,
  SETUP_GUIDE_LIMITS,
  SETUP_GUIDE_VARIABLES,
  type StaticExtensionManifest,
  setupGuideFileProblem,
  setupGuideModes,
  setupGuidePlaceholders,
  unknownSetupGuidePlaceholders,
} from "../src/index.js";

const ext = (provides: string[]): StaticExtensionManifest => ({
  name: "slack",
  version: "1.0.0",
  sdk: "^0.1.0-rc.0",
  provides,
  requires: [],
  optional: [],
  permissions: {},
  config: { deployment: [], org: [] },
});

const guide = (over: Partial<PluginSetupGuide> = {}): PluginSetupGuide => ({
  id: "slack-app",
  place: "channel-connection",
  title: { en: "Create the Slack app", zh: "创建 Slack 应用" },
  steps: [{ en: "Open the Slack apps page.", zh: "打开 Slack 应用页面。" }],
  files: [
    {
      path: "./guides/slack/app-manifest.socket.yaml.tmpl",
      title: { en: "App manifest" },
      language: "yaml",
      mode: "long_connection",
    },
    {
      path: "./guides/slack/app-manifest.webhook.yaml.tmpl",
      title: { en: "App manifest" },
      language: "yaml",
      mode: "webhook",
    },
  ],
  ...over,
});

const manifest = (guides: unknown[], extension?: StaticExtensionManifest) => ({
  schemaVersion: 1,
  name: "slack",
  version: "1.0.0",
  publisher: "Capybara",
  description: "Slack",
  setupGuides: guides,
  ...(extension !== undefined && {
    extension: { entry: "./dist/index.mjs", manifest: extension },
  }),
});

const errorsOf = (json: unknown): string[] => {
  const r = parsePluginManifest(json);
  return "errors" in r ? r.errors : [];
};

describe("plugin.json setupGuides", () => {
  it("accepts a channel guide with per-mode files on a channel@1 extension", () => {
    const r = parsePluginManifest(manifest([guide()], ext(["channel@1"])));
    expect("errors" in r ? r.errors : []).toEqual([]);
    expect(!("errors" in r) && r.setupGuides?.[0]?.files).toHaveLength(2);
    // a source plugin.json has no extension: the kernel's reader checks channel@1 then
    expect(errorsOf(manifest([guide()]))).toEqual([]);
  });

  it("refuses unsafe paths, other file types, unknown places, modes and languages", () => {
    const file = (over: Record<string, unknown>) => ({
      path: "./guides/a.yaml",
      title: { en: "A" },
      language: "yaml",
      ...over,
    });
    const errs = (g: Record<string, unknown>) => errorsOf(manifest([{ ...guide(), ...g }]));
    expect(errs({ files: [file({ path: "./../etc/passwd.txt" })] }).join()).toMatch(
      /inside the plugin/,
    );
    expect(errs({ files: [file({ path: "guides/a.yaml" })] }).join()).toMatch(/must start with/);
    expect(errs({ files: [file({ path: "./guides/a.sh" })] }).join()).toMatch(/\.tmpl, \.yaml/);
    expect(errs({ files: [file({ language: "html" })] }).join()).toMatch(/language/);
    expect(errs({ files: [file({ mode: "polling" })] }).join()).toMatch(
      /mode must be one of long_connection, webhook/,
    );
    expect(errs({ steps: [{ en: "x", mode: "socket" }] }).join()).toMatch(/mode must be one of/);
    expect(errs({ place: "dashboard" }).join()).toMatch(/place/);
    expect(errs({ steps: [], files: [] }).join()).toMatch(/at least one step or file/);
    expect(errs({ files: [file({}), file({})] }).join()).toMatch(/duplicate file/);
    expect(errs({ steps: [{ en: "x", html: "<b>" }] }).join()).toMatch(/html/);
    expect(errs({ steps: [{ en: "x".repeat(SETUP_GUIDE_LIMITS.stepChars + 1) }] })).toHaveLength(1);
  });

  it("refuses duplicate ids, too many guides and a channel guide without channel@1", () => {
    expect(errorsOf(manifest([guide(), guide()])).join()).toMatch(/duplicate setup guide id/);
    const many = Array.from({ length: SETUP_GUIDE_LIMITS.guides + 1 }, (_, i) =>
      guide({ id: `g${i}` }),
    );
    expect(errorsOf(manifest(many)).length).toBeGreaterThan(0);
    expect(errorsOf(manifest([guide()], ext(["identity-source@1"]))).join()).toMatch(
      /needs the plugin's extension to provide channel@1/,
    );
  });

  it("the committed JSON Schema accepts a guide and refuses an unknown key in it", () => {
    const schema = JSON.parse(
      readFileSync(new URL("../schemas/plugin.v1.schema.json", import.meta.url), "utf8"),
    ) as object;
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats.default(ajv);
    const validate = ajv.compile(schema);
    expect(validate(manifest([guide()]))).toBe(true);
    expect(validate(manifest([{ ...guide(), script: "rm -rf /" }]))).toBe(false);
  });
});

describe("setup guide placeholders and rendering", () => {
  it("finds placeholders, flags the ones the place does not define", () => {
    const t =
      "url: {{ webhookUrl }}\nname: {{connectionName}} {{webhookUrl}} {{appSecret}} {{x.y}}";
    expect(setupGuidePlaceholders(t)).toEqual(["webhookUrl", "connectionName", "appSecret"]);
    expect(unknownSetupGuidePlaceholders(t, "channel-connection")).toEqual(["appSecret"]);
    expect(SETUP_GUIDE_VARIABLES["channel-connection"]).toContain("signInCallbackUrl");
  });

  it("substitutes known values, escapes for YAML / JSON, keeps unknown and unresolved visible", () => {
    const known = SETUP_GUIDE_VARIABLES["channel-connection"];
    const r = renderSetupGuideText(
      'name: "{{connectionName}}"\nurl: "{{webhookUrl}}"\nsecret: {{appSecret}}\n{not: {{ a-b }}}',
      { connectionName: 'Sales "bot"\nline', webhookUrl: null },
      "yaml",
      known,
    );
    expect(r.text).toBe(
      'name: "Sales \\"bot\\"\\nline"\nurl: "{{webhookUrl}}"\nsecret: {{appSecret}}\n{not: {{ a-b }}}',
    );
    expect(r.unresolved).toEqual(["webhookUrl"]);
    // text: control characters become spaces, nothing else changes
    expect(renderSetupGuideText("Hi {{orgName}}", { orgName: "A\tB<b>" }, "text").text).toBe(
      "Hi A B<b>",
    );
    // inherited keys are not values
    expect(renderSetupGuideText("{{constructor}}", {}, "text", ["constructor"]).unresolved).toEqual(
      ["constructor"],
    );
  });

  it("lists the modes a guide uses in the place's order", () => {
    expect(setupGuideModes(guide())).toEqual(["long_connection", "webhook"]);
    expect(setupGuideModes(guide({ files: [] }))).toEqual([]);
    expect(setupGuideModes(guide({ files: [], steps: [{ en: "x", mode: "webhook" }] }))).toEqual([
      "webhook",
    ]);
  });
});

describe("setupGuideFileProblem", () => {
  const enc = (t: string) => new TextEncoder().encode(t);
  it("accepts UTF-8 text within the limit, refuses missing, large, binary and NUL files", () => {
    expect(setupGuideFileProblem("a.yaml", enc("name: x\n"))).toBeUndefined();
    expect(setupGuideFileProblem("a.yaml", undefined)).toMatch(/not found/);
    expect(
      setupGuideFileProblem("a.yaml", new Uint8Array(SETUP_GUIDE_LIMITS.fileBytes + 1).fill(97)),
    ).toMatch(/larger than/);
    expect(setupGuideFileProblem("a.yaml", new Uint8Array([0xff, 0xfe]))).toMatch(/UTF-8/);
    expect(setupGuideFileProblem("a.yaml", enc("a\u0000b"))).toMatch(/NUL/);
  });
});
