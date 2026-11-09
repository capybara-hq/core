import { describe, expect, it } from "vitest";
import {
  parseSetupGuide,
  SETUP_GUIDE_LIMITS,
  SETUP_GUIDE_PLACE_INFO,
  SETUP_GUIDE_PLACES,
  type SetupGuideIssue,
  type SetupGuidePlace,
  setupGuideDocPath,
  setupGuideDocProblem,
  validateSetupGuide,
} from "../src/index.js";

const F = "```";

const errors = (issues: SetupGuideIssue[]) =>
  issues.filter((i) => i.level === "error").map((i) => i.message);
const warnings = (issues: SetupGuideIssue[]) =>
  issues.filter((i) => i.level === "warning").map((i) => i.message);

const v = (
  en: string,
  over: { place?: SetupGuidePlace; zh?: string; pluginChecks?: string[] } = {},
) =>
  validateSetupGuide({ id: "slack-app", place: over.place ?? "channel-connection", en, ...over });

const doc = (...lines: string[]) => ["# Create the Slack app", "", ...lines, ""].join("\n");

describe("places and paths", () => {
  it("defines the two places with their modes, audiences and variables", () => {
    expect(SETUP_GUIDE_PLACES).toEqual(["channel-connection", "connector-template"]);
    const ch = SETUP_GUIDE_PLACE_INFO["channel-connection"];
    expect(ch.modes).toEqual(["long_connection", "webhook"]);
    expect(ch.audiences).toEqual(["admin"]);
    expect(ch.variables).toMatchObject({
      publicUrl: "url",
      orgName: "text",
      pluginName: "token",
      pluginVersion: "token",
      mode: "token",
      webhookUrl: "url",
      signInCallbackUrl: "url",
      connectionName: "text",
    });
    expect(ch.drift).toBe(true);
    const ct = SETUP_GUIDE_PLACE_INFO["connector-template"];
    expect(ct.modes).toEqual([]);
    expect(ct.audiences).toEqual(["admin", "member"]);
    expect(ct.variables).toMatchObject({
      publicUrl: "url",
      oauthCallbackUrl: "url",
      signInCallbackUrl: "url",
      templateId: "token",
      templateName: "text",
      connectorName: "text",
    });
    expect(ct.variables).not.toHaveProperty("connectionName");
  });

  it("names the documents by convention", () => {
    expect(setupGuideDocPath("slack-app", "en")).toBe("guides/slack-app.md");
    expect(setupGuideDocPath("slack-app", "zh")).toBe("guides/slack-app.zh.md");
  });

  it("setupGuideDocProblem refuses missing, large, binary, NUL and private-use files", () => {
    const enc = (t: string) => new TextEncoder().encode(t);
    expect(setupGuideDocProblem("guides/a.md", enc("# A\n"))).toBeUndefined();
    expect(setupGuideDocProblem("guides/a.md", undefined)).toMatch(/not found/);
    expect(
      setupGuideDocProblem("guides/a.md", new Uint8Array(SETUP_GUIDE_LIMITS.docBytes + 1).fill(97)),
    ).toMatch(/larger than 65536 bytes/);
    expect(setupGuideDocProblem("guides/a.md", new Uint8Array([0xff, 0xfe]))).toMatch(/UTF-8/);
    expect(setupGuideDocProblem("guides/a.md", enc("a\u0000b"))).toMatch(/NUL/);
    expect(setupGuideDocProblem("guides/a.md", enc("ab"))).toMatch(/private-use/);
  });
});

describe("validateSetupGuide: the document", () => {
  it("accepts a well-formed guide", () => {
    const en = doc(
      "Intro with `{{webhookUrl}}`.",
      "",
      "::: mode webhook",
      `${F}yaml title="App manifest"`,
      'url: "{{webhookUrl}}"',
      F,
      "::check capybara:webhook-public Webhook address is reachable",
      ":::",
      "",
      "::check bot-token Bot token works",
    );
    expect(v(en)).toEqual([]);
  });

  it("requires one leading level-1 heading", () => {
    expect(errors(v("Intro\n\n# Title\n")).join()).toMatch(/must start with a level-1 heading/);
    expect(errors(v("\n\n# Title\n\ntext\n"))).toEqual([]);
    expect(errors(v(doc("# Another"))).join("\n")).toMatch(/level-1 heading/);
    expect(errors(v(doc("Another", "==="))).join("\n")).toMatch(/level-1 heading/);
    expect(errors(v(`# ${"x".repeat(101)}\n`)).join()).toMatch(/title.*100/);
    expect(errors(v(doc(`## ${"x".repeat(101)}`))).join()).toMatch(/heading.*100/);
    expect(errors(v(doc("##### Deep"))).join()).toMatch(/## to ####/);
  });

  it("parses mode and audience sections", () => {
    const ct = (en: string) => v(en, { place: "connector-template" });
    expect(
      errors(
        ct(doc("::: audience admin", "Admin.", "", ":::", "::: audience member", "M.", ":::")),
      ),
    ).toEqual([]);
    // a mode inside an audience is accepted (here on a place with both)
    expect(errors(v(doc("::: audience admin", "::: mode webhook", "W", ":::", ":::")))).toEqual([]);
    expect(
      errors(v(doc("::: mode webhook", "::: mode long_connection", "x", ":::", ":::"))).join(),
    ).toMatch(/sections do not nest/);
    expect(errors(v(doc("::: mode polling", "x", ":::"))).join()).toMatch(
      /mode "polling".*long_connection, webhook/,
    );
    expect(errors(ct(doc("::: mode webhook", "x", ":::"))).join()).toMatch(/no modes/);
    expect(errors(v(doc("::: audience member", "x", ":::"))).join()).toMatch(
      /audience "member".*admin/,
    );
    expect(errors(v(doc("::: mode webhook", "x"))).join()).toMatch(/not closed/);
    expect(errors(v(doc("x", ":::"))).join()).toMatch(/closes no section/);
    expect(errors(v(doc("::: modes webhook", "x", ":::"))).join()).toMatch(/section line/);
    expect(errors(v(doc("::: mode {{mode}}", "x", ":::"))).join()).toMatch(/variables/);
  });

  it("ignores directive lines inside fenced code", () => {
    const en = doc(`${F}text`, "::check a b", ":::", "::: mode nope", F);
    expect(v(en)).toEqual([]);
    const p = parseSetupGuide(en);
    expect(p.checks).toEqual([]);
    expect(p.sections).toEqual([]);
    expect(p.codeBlocks).toEqual([
      expect.objectContaining({ language: "text", text: "::check a b\n:::\n::: mode nope" }),
    ]);
  });

  it("parses check lines", () => {
    const p = parseSetupGuide(
      doc("::check bot-token Bot token works", "::check capybara:public-url Public URL"),
    );
    expect(p.checks).toEqual([
      expect.objectContaining({ id: "bot-token", label: "Bot token works", source: "plugin" }),
      expect.objectContaining({ id: "capybara:public-url", label: "Public URL", source: "kernel" }),
    ]);
    expect(errors(v(doc("::check Bot_token Works"))).join()).toMatch(/check id/);
    expect(errors(v(doc("::check capybara:Bad x"))).join()).toMatch(/check id/);
    expect(errors(v(doc("::check bot-token"))).join()).toMatch(/label/);
    expect(errors(v(doc(`::check bot-token ${"x".repeat(81)}`))).join()).toMatch(/80/);
    expect(errors(v(doc("::check bot-token Token of {{orgName}}"))).join()).toMatch(/variables/);
    expect(errors(v(doc("::check a A", "::check a A again"))).join()).toMatch(/twice/);
    // the same check in two modes is fine
    expect(
      errors(
        v(
          doc(
            "::: mode webhook",
            "::check a A",
            ":::",
            "::: mode long_connection",
            "::check a A",
            ":::",
          ),
        ),
      ),
    ).toEqual([]);
  });

  it("refuses indented code and private-use characters", () => {
    expect(errors(v(doc("Para", "", "    indented code"))).join()).toMatch(/indented code/);
    expect(errors(v(doc("a  b"))).join()).toMatch(/private-use/);
    expect(errors(v(doc("a\u0000b"))).join()).toMatch(/NUL/);
  });

  it("checks fence info strings", () => {
    expect(errors(v(doc(F, "x", F))).join()).toMatch(/needs a language/);
    expect(errors(v(doc(`${F}yaml foo=bar`, "x", F))).join()).toMatch(/info string/);
    expect(errors(v(doc(`${F}yaml title="${"t".repeat(101)}"`, "x", F))).join()).toMatch(/100/);
    expect(errors(v(doc(`${F}yaml title="{{orgName}}"`, "x", F))).join()).toMatch(/info string/);
  });

  it("refuses variables the place does not define", () => {
    expect(errors(v(doc("Secret {{appSecret}}"))).join()).toMatch(
      /unknown variable \{\{appSecret\}\}/,
    );
    expect(errors(v(doc("{{oauthCallbackUrl}}"))).join()).toMatch(/oauthCallbackUrl/);
    expect(errors(v(doc("{{oauthCallbackUrl}}"), { place: "connector-template" }))).toEqual([]);
  });

  it("refuses variables in fence info strings, directive lines and link titles", () => {
    expect(errors(v(doc(`${F}yaml{{mode}}`, "x", F))).join()).toMatch(/info string/);
    expect(errors(v(doc('[x](https://a.example "{{orgName}}")'))).join()).toMatch(/link title/);
    expect(errors(v(doc("[x](https://a.example/{{publicUrl}})"))).join()).toMatch(
      /link destination/,
    );
    expect(errors(v(doc("[x]({{connectionName}})"))).join()).toMatch(/link destination/);
    expect(errors(v(doc("![{{orgName}}](https://a.example/i.png)"))).join()).toMatch(/image/);
    expect(errors(v(doc("[x]({{webhookUrl}})", "", "<{{publicUrl}}>")))).toEqual([]);
  });

  it("warns about a text variable in a non-yaml/json fence", () => {
    const sh = v(doc(`${F}sh`, "echo {{connectionName}}", F));
    expect(errors(sh)).toEqual([]);
    expect(warnings(sh).join()).toMatch(/connectionName.*not quoted/);
    expect(v(doc(`${F}yaml`, 'name: "{{connectionName}}"', F))).toEqual([]);
    expect(v(doc(`${F}sh`, "curl {{webhookUrl}}", F))).toEqual([]);
  });

  it("warns about a text variable outside double quotes in a yaml or json fence", () => {
    const bare = v(doc(`${F}yaml`, "name: {{connectionName}}", F));
    expect(errors(bare)).toEqual([]);
    expect(warnings(bare).join()).toMatch(/connectionName.*double quotes/);
    expect(warnings(v(doc(`${F}json`, '{ "a": "x", "n": {{orgName}} }', F))).join()).toMatch(
      /orgName.*double quotes/,
    );
    expect(v(doc(`${F}yaml`, 'name: "a \\" {{connectionName}}"', F))).toEqual([]);
    expect(v(doc(`${F}json`, '{ "n": "{{orgName}}", "u": {{publicUrl}} }', F))).toEqual([]);
  });

  it("refuses a check line inside raw HTML", () => {
    expect(errors(v(doc("<div>", "::check bot-token Works", "</div>"))).join()).toMatch(
      /check bot-token.*HTML/,
    );
  });

  it("refuses check ids missing from pluginChecks when given", () => {
    const en = doc("::check bot-token Works", "::check capybara:public-url Public URL");
    expect(v(en, { pluginChecks: ["bot-token"] })).toEqual([]);
    expect(errors(v(en, { pluginChecks: [] })).join()).toMatch(
      /bot-token.*permissions\.setupChecks/,
    );
    expect(v(en)).toEqual([]);
  });

  it("enforces the limits", () => {
    const L = SETUP_GUIDE_LIMITS;
    expect(L).toEqual({
      guides: 8,
      docBytes: 65536,
      codeBlocks: 24,
      checks: 16,
      sections: 16,
      titleChars: 100,
      checkLabelChars: 80,
      fenceTitleChars: 100,
      depth: 16,
    });
    expect(errors(v(doc("x".repeat(L.docBytes)))).join()).toMatch(/65536 bytes/);
    const blocks = Array.from({ length: L.codeBlocks + 1 }, () => `${F}text\nx\n${F}\n`);
    expect(errors(v(doc(...blocks))).join()).toMatch(/code blocks/);
    const checks = Array.from({ length: L.checks + 1 }, (_, i) => `::check c${i} C ${i}`);
    expect(errors(v(doc(...checks))).join()).toMatch(/check lines/);
    const sections = Array.from({ length: L.sections + 1 }, () => "::: mode webhook\nx\n:::");
    expect(errors(v(doc(...sections))).join()).toMatch(/sections/);
    expect(errors(v(doc(`${">".repeat(L.depth + 1)} deep`))).join()).toMatch(/nested deeper/);
    expect(errors(v(doc(`${">".repeat(L.depth - 2)} ok`)))).toEqual([]);
  });

  it("names the file and line in messages", () => {
    expect(errors(v(doc("x", ":::")))[0]).toMatch(/^guides\/slack-app\.md:4: /);
    expect(errors(v(doc("ok"), { zh: "# 标题\n\n:::\n" })).join()).toMatch(
      /guides\/slack-app\.zh\.md:3: /,
    );
  });
});

describe("validateSetupGuide: language parity", () => {
  const manifest = (line14: string) =>
    Array.from({ length: 20 }, (_, i) => (i === 13 ? line14 : `key${i + 1}: value`)).join("\n");
  const en = doc(
    "::: mode webhook",
    `${F}yaml title="First"`,
    "a: 1",
    F,
    "::check a A",
    ":::",
    `${F}yaml title="App manifest (Socket Mode)"`,
    manifest("name: x"),
    F,
  );
  const zh = (code2: string, extra = "") =>
    [
      "# 创建 Slack 应用",
      "",
      "::: mode webhook",
      `${F}yaml title="第一个"`,
      "a: 1",
      F,
      "::check a 甲",
      ":::",
      `${F}yaml title="应用 manifest（Socket Mode）"`,
      code2,
      F,
      extra,
    ].join("\n");

  it("accepts a translation with the same blocks, sections and checks", () => {
    expect(v(en, { zh: zh(manifest("name: x")) })).toEqual([]);
  });

  it("refuses a code block that differs, naming the block and line", () => {
    expect(errors(v(en, { zh: zh(manifest("name: y")) }))).toEqual([
      'guides/slack-app.zh.md: code block 2 ("应用 manifest（Socket Mode）") differs from guides/slack-app.md block 2 at line 14; code blocks must be identical in every language',
    ]);
  });

  it("refuses different sections, checks or code block counts", () => {
    expect(errors(v(en, { zh: zh(manifest("name: x"), "::check b B") })).join()).toMatch(/checks/);
    expect(
      errors(v(en, { zh: zh(manifest("name: x"), "::: mode long_connection\nx\n:::") })).join(),
    ).toMatch(/sections/);
    expect(errors(v(en, { zh: zh(manifest("name: x"), `${F}text\nx\n${F}`) })).join()).toMatch(
      /code blocks/,
    );
  });

  it("refuses a code block that sits in another section", () => {
    const enDoc = doc("::: mode webhook", `${F}yaml`, "a: 1", F, ":::");
    const zhDoc = doc(`${F}yaml`, "a: 1", F, "::: mode webhook", ":::");
    expect(errors(v(enDoc, { zh: zhDoc }))).toEqual([
      "guides/slack-app.zh.md: code block 1 is in another section than guides/slack-app.md block 1; code blocks must be identical in every language",
    ]);
  });
});
