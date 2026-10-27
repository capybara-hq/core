// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Claude Code variables such as ${CLAUDE_PLUGIN_ROOT} are plain text here
import {
  PLUGIN_MANIFEST_FILE,
  parseConnectorTemplateFile,
  SDK_VERSION,
} from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { mcpServerTemplates } from "../../src/catalog/claude/mcp.js";
import type { TranslationItem, TranslationReport } from "../../src/catalog/claude/report.js";
import {
  type ClaudeTranslateOptions,
  isClaudePluginTree,
  translateClaudePlugin,
} from "../../src/catalog/claude/translate.js";
import { PluginPackageError, readPluginFiles } from "../../src/catalog/plugin-package.js";
import { loadFixture, withFiles } from "./claude-fixtures.js";

const OPTS: ClaudeTranslateOptions = {
  fallbackName: "entry-name",
  fallbackVersion: "0.0.0-git.gabcdef012345",
  fallbackPublisher: "github.com/acme",
};

/** Items as compact rows: [group, component, name, path, code, detail]. */
const rows = (r: TranslationReport | TranslationItem[]) =>
  (Array.isArray(r) ? r : r.items).map((i) => [
    i.group,
    i.component,
    i.name,
    i.path ?? null,
    i.code,
    i.detail ?? null,
  ]);
const codes = (r: TranslationReport, code: string) => rows(r).filter((x) => x[4] === code);

const manifestOf = (tree: Map<string, Uint8Array>) =>
  JSON.parse(Buffer.from(tree.get(PLUGIN_MANIFEST_FILE) as Uint8Array).toString("utf8"));

const refused = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(PluginPackageError);
    expect((e as PluginPackageError).code).toBe("catalog.invalid_manifest");
    return (e as PluginPackageError).issues.join("\n");
  }
  throw new Error("expected a refusal");
};

const skill = (name: string, extra = "") =>
  `---\nname: ${name}\ndescription: Skill ${name}.${extra}\n---\n\n# ${name}\n`;

describe("translateClaudePlugin", () => {
  it("superpowers: 4 skills and the agent imported, commands ignored, SessionStart hint, other harness manifests listed", () => {
    const files = loadFixture("superpowers");
    expect(isClaudePluginTree(files)).toBe(true);
    const t = translateClaudePlugin(files, OPTS);
    expect(t.report.format).toBe("claude-code");
    expect(t.report.manifestPath).toBe(".claude-plugin/plugin.json");
    expect(t.report.sessionStart).toBe(true);
    expect(rows(t.report)).toEqual([
      ["imported", "skill", "brainstorming", "skills/brainstorming", "skill_imported", null],
      [
        "imported",
        "skill",
        "test-driven-development",
        "skills/test-driven-development",
        "skill_imported",
        null,
      ],
      [
        "imported",
        "skill",
        "using-superpowers",
        "skills/using-superpowers",
        "skill_imported",
        null,
      ],
      ["imported", "skill", "writing-plans", "skills/writing-plans", "skill_imported", null],
      [
        "imported",
        "agent",
        "code-reviewer",
        "agents/code-reviewer.md",
        "agent_imported",
        { type: "superpowers:code-reviewer", model: "inherit" },
      ],
      [
        "ignored",
        "command",
        "brainstorm",
        "commands/brainstorm.md",
        "command_manual_invocation",
        null,
      ],
      [
        "ignored",
        "hook",
        "SessionStart",
        "hooks/hooks.json",
        "hooks_not_run",
        { handlers: "command" },
      ],
      ["ignored", "file", ".codex-plugin", ".codex-plugin", "other_harness", null],
      ["warnings", "hook", "SessionStart", null, "session_start_pin_hint", null],
    ]);
    expect(t.repository).toBe("https://github.com/obra/superpowers");
    expect(manifestOf(t.tree)).toEqual({
      schemaVersion: 1,
      name: "superpowers",
      version: "7.0.1",
      publisher: "Jesse Vincent",
      description:
        "Core skills library for Claude Code: TDD, debugging, collaboration patterns, and proven techniques",
      license: "MIT",
      homepage: "https://github.com/obra/superpowers",
      skills: [
        { path: "./skills/brainstorming" },
        { path: "./skills/test-driven-development" },
        { path: "./skills/using-superpowers" },
        { path: "./skills/writing-plans" },
      ],
      connectorTemplates: [],
      agents: [{ path: "./.capybara-generated/agents/code-reviewer.md" }],
    });
    // package.json (npm metadata for other harnesses) is not part of the translated tree.
    expect(t.tree.has("package.json")).toBe(false);
    const c = readPluginFiles(t.tree, { hostSdkVersion: SDK_VERSION, requirePackageJson: false });
    expect(c.skills.map((s) => s.name)).toEqual([
      "brainstorming",
      "test-driven-development",
      "using-superpowers",
      "writing-plans",
    ]);
  });

  it("plugin-level fields map per §8.2 (version order, publisher fallback, displayName, homepage https only)", () => {
    const base = loadFixture("root-skill");
    const pj = (v: object) => withFiles(base, { ".claude-plugin/plugin.json": v });

    // plugin.json version wins over the entry's.
    let t = translateClaudePlugin(pj({ name: "solo", version: "2.0.0" }), {
      ...OPTS,
      entryVersion: "1.0.0",
    });
    expect(manifestOf(t.tree).version).toBe("2.0.0");
    expect(codes(t.report, "version_from_entry")).toEqual([]);

    // Not semver: the entry's version, else the fallback.
    t = translateClaudePlugin(pj({ name: "solo", version: "v2" }), {
      ...OPTS,
      entryVersion: "1.0.0",
    });
    expect(manifestOf(t.tree).version).toBe("1.0.0");
    expect(codes(t.report, "version_from_entry")).toEqual([
      ["converted", "field", "version", null, "version_from_entry", { version: "1.0.0" }],
    ]);
    t = translateClaudePlugin(pj({ name: "solo" }), OPTS);
    expect(manifestOf(t.tree).version).toBe("0.0.0-git.gabcdef012345");
    expect(codes(t.report, "version_fallback")).toEqual([
      [
        "converted",
        "field",
        "version",
        null,
        "version_fallback",
        { version: "0.0.0-git.gabcdef012345" },
      ],
    ]);

    // Publisher: author.name, else the entry's, else the fallback.
    t = translateClaudePlugin(pj({ name: "solo", author: { name: "Ann" } }), OPTS);
    expect(manifestOf(t.tree).publisher).toBe("Ann");
    t = translateClaudePlugin(pj({ name: "solo" }), {
      ...OPTS,
      overlay: { strict: true, components: {}, publisher: "Market Owner" },
    });
    expect(manifestOf(t.tree).publisher).toBe("Market Owner");
    expect(codes(t.report, "publisher_from_marketplace")).toEqual([
      [
        "converted",
        "field",
        "publisher",
        null,
        "publisher_from_marketplace",
        { publisher: "Market Owner" },
      ],
    ]);

    // displayName copies into zh and en; homepage must be https; description is cut to 1024.
    t = translateClaudePlugin(
      pj({
        name: "solo",
        version: "1.0.0",
        displayName: "Solo Tools",
        homepage: "http://insecure.example",
        description: "d".repeat(2000),
        license: "MIT",
      }),
      OPTS,
    );
    const m = manifestOf(t.tree);
    expect(m.displayName).toEqual({ zh: "Solo Tools", en: "Solo Tools" });
    expect(m.homepage).toBeUndefined();
    expect(m.description).toHaveLength(1024);
    expect(m.license).toBe("MIT");
    expect(codes(t.report, "unknown_field")).toEqual([
      [
        "ignored",
        "field",
        "homepage",
        null,
        "unknown_field",
        { problem: "homepage must be an https URL" },
      ],
    ]);

    // No plugin.json: the name is the entry's; an unusable name refuses the import.
    t = translateClaudePlugin(withFiles(base, { ".claude-plugin/plugin.json": null }), OPTS);
    expect(manifestOf(t.tree).name).toBe("entry-name");
    expect(t.report.manifestPath).toBeNull();
    expect(refused(() => translateClaudePlugin(pj({ name: "Solo_Tools" }), OPTS))).toContain(
      'plugin.json name "Solo_Tools" must match ^[a-z0-9][a-z0-9-]{0,63}$',
    );
    expect(refused(() => translateClaudePlugin(pj({ version: "1.0.0" }), OPTS))).toContain(
      "name is required",
    );

    // Dependencies: the mixed fixture's three accepted forms; anything else is ignored.
    const mixed = translateClaudePlugin(loadFixture("mixed"), OPTS);
    expect(manifestOf(mixed.tree).dependencies).toEqual([
      { name: "helper", version: "*" },
      { name: "other", version: "^1.0.0" },
      { name: "shared", version: "*" },
    ]);
    expect(codes(mixed.report, "dependency_mapped")).toEqual([
      ["converted", "plugin", "helper", null, "dependency_mapped", { version: "*" }],
      ["converted", "plugin", "other", null, "dependency_mapped", { version: "^1.0.0" }],
      [
        "converted",
        "plugin",
        "shared",
        null,
        "dependency_mapped",
        { version: "*", marketplace: "acme-tools" },
      ],
    ]);
    t = translateClaudePlugin(
      pj({ name: "solo", dependencies: ["solo", 5, { name: "x", version: "not a range" }] }),
      OPTS,
    );
    expect(manifestOf(t.tree).dependencies).toBeUndefined();
    expect(rows(t.report).filter((r) => r[1] === "plugin")).toEqual([
      [
        "ignored",
        "plugin",
        "?",
        null,
        "unknown_field",
        { problem: "the dependency name must match ^[a-z0-9][a-z0-9-]{0,63}$" },
      ],
      [
        "ignored",
        "plugin",
        "solo",
        null,
        "unknown_field",
        { problem: "duplicate dependency or a dependency on itself" },
      ],
      [
        "ignored",
        "plugin",
        "x",
        null,
        "unknown_field",
        { problem: "the dependency version must be a semver range" },
      ],
    ]);
  });

  it("skill frontmatter: manual invocation, fork, ignored restrictions, Claude variables, invalid skills", () => {
    const t = translateClaudePlugin(loadFixture("mixed"), OPTS);
    expect(rows(t.report).filter((r) => r[1] === "skill")).toEqual([
      ["imported", "skill", "plain", "skills/plain", "skill_imported", null],
      ["imported", "skill", "restricted", "skills/restricted", "skill_imported", null],
      ["imported", "skill", "vars", "skills/vars", "skill_imported", null],
      [
        "ignored",
        "skill",
        "BadName",
        "skills/BadName",
        "skill_invalid",
        {
          problem:
            "name must be 1-64 lowercase letters, digits and single hyphens, not starting or ending with a hyphen",
        },
      ],
      ["ignored", "skill", "forked", "skills/forked", "skill_needs_subagents", null],
      ["ignored", "skill", "manual", "skills/manual", "skill_manual_invocation", null],
      [
        "ignored",
        "skill",
        "nofront",
        "skills/nofront",
        "skill_invalid",
        { problem: "SKILL.md must start with YAML frontmatter delimited by '---' lines" },
      ],
      [
        "warnings",
        "skill",
        "restricted",
        "skills/restricted",
        "skill_ignored_restrictions",
        { keys: "allowed-tools, model" },
      ],
      [
        "warnings",
        "skill",
        "vars",
        "skills/vars",
        "skill_claude_variables",
        { variables: "${CLAUDE_PLUGIN_ROOT}" },
      ],
    ]);
    expect(manifestOf(t.tree).skills).toEqual([
      { path: "./skills/plain" },
      { path: "./skills/restricted" },
      { path: "./skills/vars" },
    ]);

    // Listed skill paths add to skills/ (a path holding SKILL.md, or a directory of skills);
    // variables in any file of the skill count; duplicates are reported.
    const files = withFiles(loadFixture("root-skill"), {
      "SKILL.md": null,
      "helper.md": null,
      ".claude-plugin/plugin.json": {
        name: "solo",
        version: "1.0.0",
        skills: ["./extra/one", "./more", "./missing"],
      },
      "extra/one/SKILL.md": skill("one"),
      "extra/one/run.sh": "cat ${CLAUDE_PLUGIN_DATA}/x ${user_config.token}",
      "more/two/SKILL.md": skill("two", "\neffort: high\ndisallowed-tools: Bash"),
      "more/dup/SKILL.md": skill("one"),
      "skills/three/SKILL.md": skill("three"),
    });
    const t2 = translateClaudePlugin(files, OPTS);
    expect(manifestOf(t2.tree).skills).toEqual([
      { path: "./skills/three" },
      { path: "./extra/one" },
      { path: "./more/two" },
    ]);
    expect(rows(t2.report).filter((r) => r[0] !== "imported" && r[0] !== "converted")).toEqual([
      ["ignored", "skill", "missing", "missing", "skill_invalid", { problem: "no SKILL.md found" }],
      [
        "ignored",
        "skill",
        "one",
        "more/dup",
        "skill_invalid",
        { problem: "skill name one is also used by extra/one" },
      ],
      [
        "warnings",
        "skill",
        "one",
        "extra/one",
        "skill_claude_variables",
        { variables: "${CLAUDE_PLUGIN_DATA}, ${user_config.*}" },
      ],
      [
        "warnings",
        "skill",
        "two",
        "more/two",
        "skill_ignored_restrictions",
        { keys: "disallowed-tools, effort" },
      ],
    ]);
  });

  it("a root SKILL.md becomes skills/<name>/ with its files unchanged", () => {
    const files = withFiles(loadFixture("root-skill"), {
      LICENSE: "MIT\n",
      ".github/workflows/ci.yml": "on: push\n",
      "scripts/run.sh": "echo hi\n",
    });
    const t = translateClaudePlugin(files, OPTS);
    expect([...t.tree.keys()].sort()).toEqual([
      ".capybara-plugin/plugin.json",
      ".claude-plugin/plugin.json",
      ".github/workflows/ci.yml",
      "LICENSE",
      "skills/solo-skill/SKILL.md",
      "skills/solo-skill/helper.md",
      "skills/solo-skill/scripts/run.sh",
    ]);
    for (const p of ["SKILL.md", "helper.md", "scripts/run.sh"]) {
      expect(t.tree.get(`skills/solo-skill/${p}`)).toBe(files.get(p));
    }
    expect(rows(t.report).slice(0, 2)).toEqual([
      ["imported", "skill", "solo-skill", "skills/solo-skill", "skill_imported", null],
      [
        "converted",
        "skill",
        "solo-skill",
        "SKILL.md",
        "skill_root_relocated",
        { to: "skills/solo-skill" },
      ],
    ]);
    expect(manifestOf(t.tree).skills).toEqual([{ path: "./skills/solo-skill" }]);
    // With skills/ present the root SKILL.md is not a skill (Claude's rule).
    const t2 = translateClaudePlugin(
      withFiles(files, { "skills/other/SKILL.md": skill("other") }),
      OPTS,
    );
    expect(manifestOf(t2.tree).skills).toEqual([{ path: "./skills/other" }]);
    expect(t2.tree.has("SKILL.md")).toBe(true);
  });

  it(".mcp.json both shapes; http templates with bearer / api_key / headers / oauth / none; url variables; unsupported transports", () => {
    const t = translateClaudePlugin(loadFixture("mixed"), OPTS);
    expect(rows(t.report).filter((r) => r[1] === "mcpServer")).toEqual([
      [
        "converted",
        "mcpServer",
        "bearer-api",
        ".capybara-generated/connectors/bearer-api.json",
        "mcp_template",
        { template: "bearer-api", auth: "bearer" },
      ],
      [
        "converted",
        "mcpServer",
        "inline-api",
        ".capybara-generated/connectors/inline-api.json",
        "mcp_template",
        { template: "inline-api", auth: "none" },
      ],
      [
        "converted",
        "mcpServer",
        "key-api",
        ".capybara-generated/connectors/key-api.json",
        "mcp_template",
        { template: "key-api", auth: "api_key" },
      ],
      [
        "converted",
        "mcpServer",
        "oauth-api",
        ".capybara-generated/connectors/oauth-api.json",
        "mcp_template",
        { template: "oauth-api", auth: "oauth_code" },
      ],
      [
        "converted",
        "mcpServer",
        "open-api",
        ".capybara-generated/connectors/open-api.json",
        "mcp_template",
        { template: "open-api", auth: "none" },
      ],
      [
        "needsInput",
        "mcpServer",
        "bearer-api",
        ".mcp.json",
        "mcp_header_variable",
        { header: "Authorization", variable: "API_TOKEN" },
      ],
      [
        "needsInput",
        "mcpServer",
        "host-api",
        ".mcp.json",
        "mcp_url_variable",
        { variable: "HOST" },
      ],
      [
        "needsInput",
        "mcpServer",
        "key-api",
        ".mcp.json",
        "mcp_header_variable",
        { header: "X-Api-Key", variable: "KEY" },
      ],
      [
        "ignored",
        "mcpServer",
        "legacy-sse",
        ".mcp.json",
        "mcp_unsupported_transport",
        { transport: "sse" },
      ],
      [
        "ignored",
        "mcpServer",
        "local",
        ".mcp.json",
        "mcp_unsupported_transport",
        { transport: "stdio" },
      ],
      [
        "ignored",
        "mcpServer",
        "socket",
        ".mcp.json",
        "mcp_unsupported_transport",
        { transport: "ws" },
      ],
      ["warnings", "mcpServer", "inline-api", ".claude-plugin/plugin.json", "mcp_auth_none", null],
      ["warnings", "mcpServer", "open-api", ".mcp.json", "mcp_auth_none", null],
    ]);
    const tpl = (id: string) =>
      JSON.parse(
        Buffer.from(t.tree.get(`.capybara-generated/connectors/${id}.json`) as Uint8Array).toString(
          "utf8",
        ),
      );
    expect(tpl("bearer-api")).toEqual({
      displayName: { zh: "bearer-api", en: "bearer-api" },
      description: "Remote MCP server bearer-api from Claude Code plugin mixed",
      template: {
        plugin: "connector-mcp",
        connector: "mcp",
        endpoint: { url: "https://bearer.acme.example/mcp", headers: { "X-Client": "capybara" } },
        auth: { type: "bearer", ownership: "personal" },
      },
    });
    expect(tpl("key-api").template.auth).toEqual({
      type: "api_key",
      ownership: "personal",
      in: "header",
      name: "X-Api-Key",
    });
    expect(tpl("oauth-api").template.auth).toEqual({
      type: "oauth_code",
      ownership: "personal",
      discovery: "mcp",
      client: "dcr",
    });
    expect(tpl("open-api").template).toEqual({
      plugin: "connector-mcp",
      connector: "mcp",
      endpoint: { url: "https://open.acme.example/mcp" },
      auth: { type: "none" },
    });

    // The { mcpServers } shape, several header variables, a url default, a missing type, a
    // literal credential header, mixed text, a slug collision, bundles.
    const files = withFiles(loadFixture("root-skill"), {
      ".mcp.json": {
        mcpServers: {
          "Multi Header": {
            type: "http",
            url: "https://multi.example/mcp",
            headers: { "X-Tenant": "${TENANT}", "X-Key": "${KEY}" },
          },
          "multi-header": { url: "https://${HOST:-mcp.example.com}/mcp" },
          literal: {
            type: "http",
            url: "https://lit.example/mcp",
            headers: { Authorization: "Bearer abc" },
          },
          mixed: { type: "http", url: "https://m.example/mcp", headers: { "X-K": "k-${K}" } },
          plain: { type: "http", url: "http://plain.example/mcp" },
        },
      },
      ".claude-plugin/plugin.json": {
        name: "solo",
        version: "1.0.0",
        mcpServers: ["./bundle.mcpb", "https://cdn.example/x.dxt"],
      },
      "bundle.mcpb": "zip",
    });
    const t2 = translateClaudePlugin(files, OPTS);
    expect(rows(t2.report).filter((r) => r[1] === "mcpServer")).toEqual([
      [
        "converted",
        "mcpServer",
        "Multi Header",
        ".capybara-generated/connectors/multi-header.json",
        "mcp_template",
        { template: "multi-header", auth: "headers" },
      ],
      [
        "converted",
        "mcpServer",
        "multi-header",
        ".capybara-generated/connectors/multi-header-2.json",
        "mcp_template",
        { template: "multi-header-2", auth: "none" },
      ],
      [
        "needsInput",
        "mcpServer",
        "Multi Header",
        ".mcp.json",
        "mcp_header_variable",
        { header: "X-Tenant", variable: "TENANT" },
      ],
      [
        "needsInput",
        "mcpServer",
        "Multi Header",
        ".mcp.json",
        "mcp_header_variable",
        { header: "X-Key", variable: "KEY" },
      ],
      [
        "needsInput",
        "mcpServer",
        "multi-header",
        ".mcp.json",
        "mcp_url_variable",
        { variable: "HOST", default: "mcp.example.com" },
      ],
      [
        "ignored",
        "mcpServer",
        "bundle.mcpb",
        "bundle.mcpb",
        "mcp_unsupported_transport",
        { transport: "mcpb" },
      ],
      [
        "ignored",
        "mcpServer",
        "https://cdn.example/x.dxt",
        null,
        "mcp_unsupported_transport",
        { transport: "mcpb" },
      ],
      [
        "ignored",
        "mcpServer",
        "literal",
        ".mcp.json",
        "mcp_invalid",
        {
          reason: expect.stringContaining("template.endpoint.headers.Authorization"),
        },
      ],
      [
        "ignored",
        "mcpServer",
        "mixed",
        ".mcp.json",
        "mcp_invalid",
        { reason: "header X-K mixes text and a variable" },
      ],
      [
        "ignored",
        "mcpServer",
        "plain",
        ".mcp.json",
        "mcp_invalid",
        { reason: "url must be an https URL" },
      ],
      ["warnings", "mcpServer", "multi-header", ".mcp.json", "mcp_auth_none", null],
      ["warnings", "mcpServer", "multi-header", ".mcp.json", "mcp_type_assumed", null],
    ]);
    const multi = JSON.parse(
      Buffer.from(
        t2.tree.get(".capybara-generated/connectors/multi-header.json") as Uint8Array,
      ).toString("utf8"),
    );
    expect(multi.template.auth).toEqual({
      type: "headers",
      ownership: "personal",
      names: ["X-Tenant", "X-Key"],
    });
    const second = JSON.parse(
      Buffer.from(
        t2.tree.get(".capybara-generated/connectors/multi-header-2.json") as Uint8Array,
      ).toString("utf8"),
    );
    expect(second.template.endpoint).toEqual({ url: "https://mcp.example.com/mcp" });
    expect(second.template.editableEndpoint).toEqual(["url"]);
    expect(manifestOf(t2.tree).connectorTemplates).toEqual([
      { path: "./.capybara-generated/connectors/multi-header.json" },
      { path: "./.capybara-generated/connectors/multi-header-2.json" },
    ]);
  });

  it("not applicable and unknown fields never fail", () => {
    const t = translateClaudePlugin(loadFixture("mixed"), OPTS);
    expect(rows(t.report).filter((r) => r[1] === "field" || r[1] === "file")).toEqual([
      ["ignored", "field", "channels", null, "not_applicable", null],
      ["ignored", "field", "futureField", null, "unknown_field", null],
      ["ignored", "field", "lspServers", null, "not_applicable", null],
      ["ignored", "field", "monitors", null, "not_applicable", null],
      ["ignored", "field", "outputStyles", null, "not_applicable", null],
      ["ignored", "field", "themes", null, "not_applicable", null],
      ["ignored", "field", "userConfig", null, "not_applicable", null],
      ["ignored", "file", "bin", "bin", "not_applicable", null],
      ["ignored", "file", "settings.json", "settings.json", "not_applicable", null],
    ]);
    expect(
      rows(t.report).filter((r) => r[1] === "hook" || r[1] === "command" || r[1] === "agent"),
    ).toEqual([
      [
        "imported",
        "agent",
        "reviewer",
        "agents/reviewer.md",
        "agent_imported",
        { type: "mixed:reviewer", model: "fast" },
      ],
      ["ignored", "command", "run", "commands/run.md", "command_manual_invocation", null],
      [
        "ignored",
        "agent",
        "BadAgent",
        "agents/nested/BadAgent.md",
        "agent_invalid",
        { problem: "name must match ^[a-z0-9][a-z0-9-]{0,63}$ (agents are never renamed)" },
      ],
      [
        "ignored",
        "agent",
        "reviewer",
        "agents/reviewer.md",
        "agent_field_ignored",
        { keys: "isolation, memory" },
      ],
      [
        "ignored",
        "agent",
        "reviewer",
        "agents/reviewer.md",
        "not_applicable",
        { keys: "hooks, mcpServers, permissionMode" },
      ],
      ["ignored", "hook", "PreToolUse", "hooks/hooks.json", "hooks_not_run", { handlers: "http" }],
      [
        "ignored",
        "hook",
        "SessionStart",
        "hooks/hooks.json",
        "hooks_not_run",
        { handlers: "command" },
      ],
      [
        "warnings",
        "agent",
        "reviewer",
        "agents/reviewer.md",
        "agent_tools_unmapped",
        { tools: "Agent, AskUserQuestion, WebFetch" },
      ],
      ["warnings", "hook", "SessionStart", null, "session_start_pin_hint", null],
    ]);

    // Fields of the current Claude Code reference (2026-10-26): experimental.*, mods, settings,
    // listing fields, workflows, the commands object map, hooks modules.
    const t2 = translateClaudePlugin(
      withFiles(loadFixture("root-skill"), {
        ".claude-plugin/plugin.json": {
          name: "solo",
          version: "1.0.0",
          experimental: { themes: "./themes/", evals: "./evals" },
          types: "./types.d.ts",
          settings: { agent: "x" },
          defaultEnabled: false,
          metadata: {},
          supportUrl: "https://s.example",
          workflows: "./workflows/",
          commands: { about: { content: "Explain." }, status: { source: "./c/status.md" } },
          hooks: ["./hooks/mod.mjs", { Stop: [{ hooks: [{ type: "prompt" }] }] }],
        },
        ".gemini-plugin/x.json": "{}",
        "gemini-extension.json": "{}",
      }),
      OPTS,
    );
    expect(rows(t2.report).filter((r) => r[0] !== "imported" && r[0] !== "converted")).toEqual([
      ["ignored", "command", "about", null, "command_manual_invocation", null],
      ["ignored", "command", "status", "c/status.md", "command_manual_invocation", null],
      [
        "ignored",
        "hook",
        "Stop",
        ".claude-plugin/plugin.json",
        "hooks_not_run",
        { handlers: "prompt" },
      ],
      ["ignored", "hook", "hooks/mod.mjs", "hooks/mod.mjs", "hooks_module", null],
      ["ignored", "hook", "types", null, "hooks_module", null],
      ["ignored", "field", "defaultEnabled", null, "not_applicable", null],
      ["ignored", "field", "experimental.evals", null, "not_applicable", null],
      ["ignored", "field", "experimental.themes", null, "not_applicable", null],
      ["ignored", "field", "metadata", null, "not_applicable", null],
      ["ignored", "field", "settings", null, "not_applicable", null],
      ["ignored", "field", "supportUrl", null, "not_applicable", null],
      ["ignored", "field", "workflows", null, "not_applicable", null],
      ["ignored", "file", ".gemini-plugin", ".gemini-plugin", "other_harness", null],
      ["ignored", "file", "gemini-extension.json", "gemini-extension.json", "other_harness", null],
    ]);
  });

  it("strict merge rules", () => {
    const base = withFiles(loadFixture("root-skill"), {
      "SKILL.md": null,
      "helper.md": null,
      "skills/own/SKILL.md": skill("own"),
      "entry-skills/extra/SKILL.md": skill("extra"),
    });
    const entry = (strict: boolean, components: Record<string, unknown>) => ({
      ...OPTS,
      overlay: { strict, components },
    });

    // strict: true appends the entry's components.
    let t = translateClaudePlugin(base, entry(true, { skills: "./entry-skills" }));
    expect(manifestOf(t.tree).skills).toEqual([
      { path: "./skills/own" },
      { path: "./entry-skills/extra" },
    ]);
    expect(codes(t.report, "entry_components_merged")).toEqual([
      ["converted", "field", "components", null, "entry_components_merged", { keys: "skills" }],
    ]);

    // strict: false with components on both sides is a conflict.
    const both = withFiles(base, {
      ".claude-plugin/plugin.json": { name: "solo", version: "1.0.0", skills: "./skills" },
    });
    expect(
      refused(() => translateClaudePlugin(both, entry(false, { skills: "./entry-skills" }))),
    ).toContain(
      "marketplace entry entry-name sets strict: false and declares components that plugin.json declares too",
    );
    // strict: false without plugin components uses the entry's.
    t = translateClaudePlugin(base, entry(false, { skills: "./entry-skills" }));
    expect(manifestOf(t.tree).skills).toEqual([
      { path: "./skills/own" },
      { path: "./entry-skills/extra" },
    ]);

    // With plugin.json, entry mcpServers do not apply; without it the entry is the manifest.
    const servers = { mcpServers: { api: { type: "http", url: "https://api.example/mcp" } } };
    t = translateClaudePlugin(base, entry(true, servers));
    expect(manifestOf(t.tree).connectorTemplates).toEqual([]);
    expect(codes(t.report, "unknown_field")).toEqual([
      [
        "ignored",
        "field",
        "entry.mcpServers",
        null,
        "unknown_field",
        { problem: "this entry field applies only to plugins without plugin.json" },
      ],
    ]);
    t = translateClaudePlugin(
      withFiles(base, { ".claude-plugin/plugin.json": null }),
      entry(false, { ...servers, lspServers: {} }),
    );
    expect(manifestOf(t.tree).connectorTemplates).toEqual([
      { path: "./.capybara-generated/connectors/api.json" },
    ]);
    expect(codes(t.report, "entry_components_merged")).toEqual([
      [
        "converted",
        "field",
        "components",
        null,
        "entry_components_merged",
        { keys: "mcpServers, lspServers" },
      ],
    ]);
    expect(codes(t.report, "not_applicable")).toEqual([
      ["ignored", "field", "lspServers", null, "not_applicable", null],
    ]);
    // A hint makes a tree without any Claude file a Claude plugin.
    expect(isClaudePluginTree(new Map([["skills/a/SKILL.md", new Uint8Array()]]))).toBe(false);
    expect(
      isClaudePluginTree(new Map([["skills/a/SKILL.md", new Uint8Array()]]), {
        strict: true,
        components: {},
      }),
    ).toBe(true);
    expect(
      isClaudePluginTree(
        new Map([
          [PLUGIN_MANIFEST_FILE, new Uint8Array()],
          [".claude-plugin/plugin.json", new Uint8Array()],
        ]),
      ),
    ).toBe(false);
  });

  it("hostile input (Review Focus 3)", () => {
    const base = loadFixture("root-skill");
    const pj = (v: unknown, extra: Record<string, string | object | null> = {}) =>
      withFiles(base, {
        ".claude-plugin/plugin.json": typeof v === "string" ? v : (v as object),
        ...extra,
      });

    // Wrong types are report items.
    const t = translateClaudePlugin(
      pj(
        {
          name: "solo",
          version: 5,
          skills: 5,
          commands: 7,
          agents: [1],
          author: "x",
          description: 3,
        },
        { "skills/ok/SKILL.md": skill("ok") },
      ),
      OPTS,
    );
    expect(codes(t.report, "unknown_field")).toEqual([
      [
        "ignored",
        "field",
        "agents",
        null,
        "unknown_field",
        { problem: "agents must be a path or an array of paths" },
      ],
      [
        "ignored",
        "field",
        "author",
        null,
        "unknown_field",
        { problem: "author must be an object with a name" },
      ],
      [
        "ignored",
        "field",
        "commands",
        null,
        "unknown_field",
        { problem: "commands must be a path or an array of paths" },
      ],
      [
        "ignored",
        "field",
        "description",
        null,
        "unknown_field",
        { problem: "description must be a string" },
      ],
      [
        "ignored",
        "field",
        "skills",
        null,
        "unknown_field",
        { problem: "skills must be a path or an array of paths" },
      ],
    ]);

    // Paths leaving the root refuse the import by name.
    for (const [key, value] of [
      ["hooks", "../../x"],
      ["skills", "./../outside"],
      ["mcpServers", "./a/../../b.json"],
      ["commands", ["./ok.md", "./../x.md"]],
    ] as const) {
      const msg = refused(() => translateClaudePlugin(pj({ name: "solo", [key]: value }), OPTS));
      expect(msg).toContain(`.claude-plugin/plugin.json ${key}: path`);
      expect(msg).toContain("leaves the plugin root");
    }
    // A path without "./" is reported, not followed.
    const t2 = translateClaudePlugin(pj({ name: "solo", hooks: "hooks/x.json" }), OPTS);
    expect(codes(t2.report, "unknown_field")).toEqual([
      [
        "ignored",
        "field",
        "hooks",
        null,
        "unknown_field",
        { problem: 'path "hooks/x.json" must start with "./"' },
      ],
    ]);

    // Non-JSON files are items.
    const t3 = translateClaudePlugin(
      pj({ name: "solo" }, { ".mcp.json": "{not json", "hooks/hooks.json": "[]" }),
      OPTS,
    );
    expect(rows(t3.report).filter((r) => r[0] === "ignored")).toEqual([
      [
        "ignored",
        "hook",
        "hooks/hooks.json",
        "hooks/hooks.json",
        "hooks_not_run",
        { problem: "the hooks configuration is not an object" },
      ],
      [
        "ignored",
        "mcpServer",
        ".mcp.json",
        ".mcp.json",
        "mcp_invalid",
        { reason: "not valid JSON" },
      ],
    ]);

    // 1000 hook events: 100 items and one { more }.
    const events = Object.fromEntries(
      Array.from({ length: 1000 }, (_, i) => [`E${i}`, [{ hooks: [{ type: "command" }] }]]),
    );
    const t4 = translateClaudePlugin(
      pj({ name: "solo" }, { "hooks/hooks.json": { hooks: events } }),
      OPTS,
    );
    const hooks = codes(t4.report, "hooks_not_run");
    expect(hooks).toHaveLength(101);
    expect(hooks.at(-1)).toEqual(["ignored", "hook", "…", null, "hooks_not_run", { more: 900 }]);

    // 200 servers: 20 templates, the rest "too many servers".
    const servers = Object.fromEntries(
      Array.from({ length: 200 }, (_, i) => [
        `s${i}`,
        { type: "http", url: `https://s${i}.example/mcp` },
      ]),
    );
    const t5 = translateClaudePlugin(pj({ name: "solo" }, { ".mcp.json": servers }), OPTS);
    expect(codes(t5.report, "mcp_template")).toHaveLength(20);
    expect(codes(t5.report, "mcp_invalid")).toHaveLength(180);
    expect(codes(t5.report, "mcp_invalid")[0]?.[5]).toEqual({ reason: "too many servers" });

    // The report is capped at 500 items plus one { more }.
    const many = Object.fromEntries(Array.from({ length: 700 }, (_, i) => [`k${i}`, 1]));
    const t6 = translateClaudePlugin(pj({ name: "solo", ...many }), OPTS);
    expect(t6.report.items).toHaveLength(501);
    expect(rows(t6.report).at(-1)).toEqual([
      "ignored",
      "field",
      "…",
      null,
      "unknown_field",
      { more: expect.any(Number) },
    ]);

    // An unreadable plugin.json, a skill name with uppercase, nothing importable.
    expect(refused(() => translateClaudePlugin(pj("{"), OPTS))).toContain(
      ".claude-plugin/plugin.json is not valid JSON",
    );
    expect(refused(() => translateClaudePlugin(pj("[]"), OPTS))).toContain("must be a JSON object");
    expect(
      refused(() =>
        translateClaudePlugin(pj({ name: "solo" }, { "SKILL.md": skill("Upper") }), OPTS),
      ),
    ).toContain("no skill Capybara can import, no agent and no remote MCP server");
  });

  it("a root SKILL.md leaves other skills, not-applicable files, other harnesses and generated files where they are (review I2)", () => {
    const read = (t: ReturnType<typeof translateClaudePlugin>) =>
      readPluginFiles(t.tree, { hostSdkVersion: SDK_VERSION, requirePackageJson: false });
    // skills: ["./", "./custom"]: two skills, the root one does not contain custom/
    const t = translateClaudePlugin(
      withFiles(loadFixture("root-skill"), {
        ".claude-plugin/plugin.json": { name: "solo", skills: ["./", "./custom"] },
        "custom/SKILL.md": skill("custom"),
        "custom/notes.md": "notes\n",
      }),
      OPTS,
    );
    expect(manifestOf(t.tree).skills).toEqual([
      { path: "./skills/solo-skill" },
      { path: "./custom" },
    ]);
    expect([...t.tree.keys()].filter((p) => p.startsWith("skills/")).sort()).toEqual([
      "skills/solo-skill/SKILL.md",
      "skills/solo-skill/helper.md",
    ]);
    expect(t.tree.has("custom/SKILL.md")).toBe(true);
    expect(read(t).skills.map((s) => s.name)).toEqual(["solo-skill", "custom"]);

    // bin/, settings.json, other harnesses' manifests, .capybara-generated/ and package.json stay out
    const files = withFiles(loadFixture("root-skill"), {
      "bin/tool": "#!/bin/sh\n",
      "settings.json": "{}",
      ".codex-plugin/plugin.json": "{}",
      ".cursor-plugin/plugin.json": "{}",
      ".opencode/x.json": "{}",
      "gemini-extension.json": "{}",
      "output-styles/a.md": "a\n",
      "themes/t.json": "{}",
      ".capybara-generated/connectors/x.json": "{}",
      "package.json": '{"name":"solo"}',
      "scripts/run.sh": "echo hi\n",
    });
    const t2 = translateClaudePlugin(files, OPTS);
    expect([...t2.tree.keys()].filter((p) => p.startsWith("skills/")).sort()).toEqual([
      "skills/solo-skill/SKILL.md",
      "skills/solo-skill/helper.md",
      "skills/solo-skill/scripts/run.sh",
    ]);
    expect(read(t2).skills[0]?.files.sort()).toEqual(["SKILL.md", "helper.md", "scripts/run.sh"]);
    for (const p of ["bin/tool", "settings.json", ".codex-plugin/plugin.json"]) {
      expect(t2.tree.has(p)).toBe(true);
    }
  });

  it("overlapping or reserved skill paths are skill_invalid items, first one wins (review I3)", () => {
    const base = loadFixture("root-skill");
    const t = translateClaudePlugin(
      withFiles(base, {
        ".claude-plugin/plugin.json": {
          name: "solo",
          skills: ["./skills/a/sub", "./x/y", "./x", "./.capybara-plugin", "./.claude-plugin"],
        },
        "skills/a/SKILL.md": skill("a"),
        "skills/a/sub/SKILL.md": skill("sub"),
        "x/y/SKILL.md": skill("y"),
        "x/SKILL.md": skill("x"),
        ".capybara-plugin/SKILL.md": skill("cap"),
        ".claude-plugin/SKILL.md": skill("cla"),
      }),
      OPTS,
    );
    expect(manifestOf(t.tree).skills).toEqual([{ path: "./skills/a" }, { path: "./x/y" }]);
    expect(codes(t.report, "skill_invalid")).toEqual([
      [
        "ignored",
        "skill",
        ".capybara-plugin",
        ".capybara-plugin",
        "skill_invalid",
        { problem: ".capybara-plugin is a reserved directory" },
      ],
      [
        "ignored",
        "skill",
        ".claude-plugin",
        ".claude-plugin",
        "skill_invalid",
        { problem: ".claude-plugin is a reserved directory" },
      ],
      [
        "ignored",
        "skill",
        "sub",
        "skills/a/sub",
        "skill_invalid",
        { problem: "skills/a/sub is inside the skill directory skills/a" },
      ],
      [
        "ignored",
        "skill",
        "x",
        "x",
        "skill_invalid",
        { problem: "x contains the skill directory x/y" },
      ],
    ]);
    const c = readPluginFiles(t.tree, { hostSdkVersion: SDK_VERSION, requirePackageJson: false });
    expect(c.skills.map((s) => s.name)).toEqual(["a", "y"]);
    // .capybara-generated is reserved too
    const t2 = translateClaudePlugin(
      withFiles(base, {
        ".claude-plugin/plugin.json": { name: "solo", skills: ["./.capybara-generated/s"] },
        ".capybara-generated/s/SKILL.md": skill("gen"),
        "skills/ok/SKILL.md": skill("ok"),
      }),
      OPTS,
    );
    expect(codes(t2.report, "skill_invalid").map((r) => r[5])).toEqual([
      { problem: ".capybara-generated/s is a reserved directory" },
    ]);
  });

  it("__proto__ keys, root component paths, controls in names and credentials in MCP URLs are report items (review M1, M2, M6, M7)", () => {
    const base = loadFixture("root-skill");
    // M1: a __proto__ server and header are reported, the other server still translates
    const mcpJson = `{"__proto__": {"type": "http", "url": "https://p.example/mcp"}, "ok": {"type": "http", "url": "https://ok.example/mcp", "headers": {"__proto__": "x"}}, "fine": {"type": "http", "url": "https://fine.example/mcp"}}`;
    const t = translateClaudePlugin(withFiles(base, { ".mcp.json": mcpJson }), OPTS);
    expect(codes(t.report, "mcp_invalid").map((r) => [r[2], r[5]])).toEqual([
      ["__proto__", { reason: "the server name __proto__ is not allowed" }],
      ["ok", { reason: "the header name __proto__ is not allowed" }],
    ]);
    expect(codes(t.report, "mcp_template").map((r) => r[2])).toEqual(["fine"]);

    // M2: "./" for commands / agents / hooks / mcpServers is an item, not a refusal
    for (const key of ["commands", "agents", "hooks", "mcpServers"]) {
      const t2 = translateClaudePlugin(
        withFiles(base, { ".claude-plugin/plugin.json": { name: "solo", [key]: "./" } }),
        OPTS,
      );
      expect(codes(t2.report, "unknown_field")).toEqual([
        [
          "ignored",
          "field",
          key,
          null,
          "unknown_field",
          { problem: 'path "./" must not be the plugin root' },
        ],
      ]);
    }

    // M6: C1 and bidi controls never reach a name or a detail
    const t3 = translateClaudePlugin(
      withFiles(base, {
        ".claude-plugin/plugin.json": {
          name: "solo",
          "evil‮name\u0085": 1,
          dependencies: ["dep@mkt⁦x"],
        },
      }),
      OPTS,
    );
    const text = JSON.stringify(t3.report.items);
    expect(text).not.toMatch(/[\u0080-\u009f‪-‮⁦-⁩]/);
    expect(codes(t3.report, "unknown_field").map((r) => r[2])).toEqual(["evil?name?"]);
    expect(codes(t3.report, "dependency_mapped")[0]?.[5]).toEqual({
      version: "*",
      marketplace: "mkt?x",
    });

    // M7: user info or a credential-like query parameter in the URL
    const t4 = translateClaudePlugin(
      withFiles(base, {
        ".mcp.json": {
          userinfo: { type: "http", url: "https://user:tok@host.example/mcp" },
          query: { type: "http", url: "https://host.example/mcp?api_key=abc" },
          plain: { type: "http", url: "https://host.example/mcp?region=eu" },
        },
      }),
      OPTS,
    );
    expect(codes(t4.report, "mcp_invalid").map((r) => [r[2], r[5]])).toEqual([
      ["query", { reason: 'the url query parameter "api_key" looks like a credential' }],
      ["userinfo", { reason: "the url must not contain a user name or password" }],
    ]);
    expect(codes(t4.report, "mcp_template").map((r) => r[2])).toEqual(["plain"]);
  });

  it("repeated and excess declared paths: deduplicated, capped at 100 per key, each JSON file parsed once (final review I1)", () => {
    // A large hooks file: 2000 events, about 100 K characters.
    const hooks: Record<string, unknown> = {};
    for (let i = 0; i < 2000; i++) {
      hooks[`Event${i}`] = [{ hooks: [{ type: "command", command: `echo ${"x".repeat(20)}` }] }];
    }
    // Within the 256 K-character manifest cap: 10 000 hooks paths, 5000 skills and servers.
    const missing = (n: number) => Array.from({ length: n }, (_, i) => `./m${i}`);
    const base = withFiles(loadFixture("root-skill"), {
      "SKILL.md": null,
      "helper.md": null,
      "skills/own/SKILL.md": skill("own"),
      "h.json": { hooks },
      ".claude-plugin/plugin.json": {
        name: "flood",
        version: "1.0.0",
        hooks: Array(10_000).fill("./h.json"),
        skills: ["./skills", ...missing(5000)],
        mcpServers: Array(5000).fill("./h.json"),
      },
    });
    const started = performance.now();
    const t = translateClaudePlugin(base, OPTS);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(manifestOf(t.tree).skills).toEqual([{ path: "./skills/own" }]);
    // One "too many paths" item per key, counting what was left out.
    expect(
      codes(t.report, "unknown_field").filter(
        (r) => (r[5] as { problem?: string })?.problem === "too many paths",
      ),
    ).toEqual([
      [
        "ignored",
        "field",
        "skills",
        null,
        "unknown_field",
        { problem: "too many paths", more: 4_901 },
      ],
    ]);
    // 2000 events -> 100 items plus one "more" item; no repeated event items.
    const hookRows = codes(t.report, "hooks_not_run");
    expect(hookRows.length).toBe(101);
    expect(new Set(hookRows.map((r) => r[2])).size).toBe(101);
    // The skills under the cap that do not exist are one item each, the rest are counted.
    expect(codes(t.report, "skill_invalid").length).toBe(99);

    // The marketplace entry overlay is a second route in (no plugin.json: the entry is the manifest).
    const viaEntry = withFiles(base, { ".claude-plugin/plugin.json": null });
    const started2 = performance.now();
    const t2 = translateClaudePlugin(viaEntry, {
      ...OPTS,
      overlay: {
        strict: true,
        components: {
          hooks: Array(10_000).fill("./h.json"),
          skills: missing(10_000),
          mcpServers: missing(10_000).map((m) => `${m}.json`),
        },
      },
    });
    expect(performance.now() - started2).toBeLessThan(1000);
    expect(
      codes(t2.report, "unknown_field")
        .filter((r) => (r[5] as { problem?: string })?.problem === "too many paths")
        .map((r) => [r[2], r[5]]),
    ).toEqual([
      ["mcpServers", { problem: "too many paths", more: 9_900 }],
      ["skills", { problem: "too many paths", more: 9_900 }],
    ]);
    expect(codes(t2.report, "hooks_not_run").length).toBe(101);
  });

  it("report paths are printable (final review m2)", () => {
    const t = translateClaudePlugin(
      withFiles(loadFixture("root-skill"), {
        "SKILL.md": null,
        "helper.md": null,
        "skills/a\u202eb/SKILL.md": skill("ab"),
        "commands/c\u0085d.md": "# c",
      }),
      OPTS,
    );
    const paths = t.report.items.flatMap((i) => (i.path === undefined ? [] : [i.path]));
    expect(paths).toContain("skills/a?b");
    expect(paths).toContain("commands/c?d.md");
    for (const p of paths) expect(p).not.toMatch(/[\u0080-\u009f\u202a-\u202e]/);
  });

  it("every generated template parses with parseConnectorTemplateFile and every stored skill byte equals the input", () => {
    for (const name of ["superpowers", "mixed", "root-skill"]) {
      const files = loadFixture(name);
      const t = translateClaudePlugin(files, OPTS);
      const c = readPluginFiles(t.tree, { hostSdkVersion: SDK_VERSION, requirePackageJson: false });
      for (const tpl of c.connectorTemplates) {
        const text = Buffer.from(t.tree.get(tpl.path) as Uint8Array).toString("utf8");
        expect(parseConnectorTemplateFile(text)).not.toHaveProperty("errors");
      }
      for (const s of c.skills) {
        for (const f of s.files) {
          const out = t.tree.get(`${s.dir}/${f}`) as Uint8Array;
          const src = name === "root-skill" ? files.get(f) : files.get(`${s.dir}/${f}`);
          expect(Buffer.compare(Buffer.from(out), Buffer.from(src as Uint8Array))).toBe(0);
        }
      }
    }
    // The pure template helper on its own.
    const r = mcpServerTemplates({ local: { type: "http", url: "http://127.0.0.1:9/mcp" } }, "p", {
      allowInsecureLoopback: true,
    });
    expect([...r.files.keys()]).toEqual(["local"]);
    expect(
      mcpServerTemplates({ local: { type: "http", url: "http://127.0.0.1:9/mcp" } }, "p").files
        .size,
    ).toBe(0);
  });
});

describe("Claude agents/*.md (phase C, sub-agents spec §16.4)", () => {
  const agentsOf = (tree: Map<string, Uint8Array>) =>
    readPluginFiles(tree, { hostSdkVersion: SDK_VERSION, requirePackageJson: false })
      .agentTemplates;

  it("superpowers code-reviewer imports as superpowers:code-reviewer with model inherit and the parent's tools", () => {
    const files = loadFixture("superpowers");
    const t = translateClaudePlugin(files, OPTS);
    const [a, ...rest] = agentsOf(t.tree);
    expect(rest).toEqual([]);
    expect(a?.name).toBe("code-reviewer");
    expect(a?.path).toBe(".capybara-generated/agents/code-reviewer.md");
    expect(a?.template.model).toBe("inherit");
    expect(a?.template.tools).toBeUndefined();
    // the body is copied unchanged and the source file is never rewritten
    const src = Buffer.from(files.get("agents/code-reviewer.md") as Uint8Array).toString("utf8");
    expect(src.endsWith(a?.template.instructions as string)).toBe(true);
    expect(a?.template.instructions).toContain("You are a Senior Code Reviewer");
    expect(t.tree.get("agents/code-reviewer.md")).toBe(files.get("agents/code-reviewer.md"));
  });

  it("mixed reviewer: tools mapped, Agent / AskUserQuestion / WebFetch dropped with agent_tools_unmapped, haiku -> fast, permissionMode / hooks / mcpServers not_applicable, memory / isolation agent_field_ignored", () => {
    const t = translateClaudePlugin(loadFixture("mixed"), OPTS);
    expect(agentsOf(t.tree).map((a) => a.template)).toEqual([
      {
        name: "reviewer",
        description: "Reviews code",
        instructions: "\nYou review code.\n",
        tools: ["sandbox_read", "sandbox_grep", "sandbox_bash"],
        model: "fast",
        maxSteps: 12,
        skills: ["plain"],
      },
    ]);
    expect(codes(t.report, "agent_model_mapped")).toEqual([]);
  });

  it("a name with uppercase is agent_invalid, never renamed", () => {
    const t = translateClaudePlugin(loadFixture("mixed"), OPTS);
    expect(codes(t.report, "agent_invalid").map((r) => r[2])).toEqual(["BadAgent"]);
    expect([...t.tree.keys()].filter((p) => p.startsWith(".capybara-generated/agents/"))).toEqual([
      ".capybara-generated/agents/reviewer.md",
    ]);
  });

  it("tool lists, disallowed patterns, model ids, skills and the rest of the field table", () => {
    const agent = (front: string) =>
      withFiles(loadFixture("root-skill"), {
        "agents/a.md": `---\nname: a\ndescription: A.\n${front}---\nBody.\n`,
      });
    const one = (front: string) => {
      const t = translateClaudePlugin(agent(front), OPTS);
      return {
        template: agentsOf(t.tree)[0]?.template,
        items: rows(t.report).filter((r) => r[1] === "agent" && r[4] !== "agent_imported"),
      };
    };
    // a YAML list, a pattern in tools is dropped (it would widen), MultiEdit and Edit dedupe
    expect(
      one("tools: [Edit, MultiEdit, 'Bash(git status:*)', Skill, TodoWrite, ToolSearch, Task]\n"),
    ).toEqual({
      template: {
        name: "a",
        description: "A.",
        instructions: "Body.\n",
        tools: ["sandbox_edit", "skill_load", "todo__write", "tool_search"],
      },
      items: [
        [
          "warnings",
          "agent",
          "a",
          "agents/a.md",
          "agent_tools_unmapped",
          { tools: "Bash(git status:*), Task" },
        ],
      ],
    });
    // a pattern in disallowedTools disallows the whole tool (narrower, never wider)
    expect(one("disallowedTools: 'Bash(rm:*), Write'\n").template?.disallowedTools).toEqual([
      "sandbox_bash",
      "sandbox_write",
    ]);
    // full model ids map by family; anything else inherits; both are reported
    expect(one("model: claude-opus-4-1\n")).toMatchObject({
      template: { model: "capable" },
      items: [
        [
          "converted",
          "agent",
          "a",
          "agents/a.md",
          "agent_model_mapped",
          { from: "claude-opus-4-1", to: "capable" },
        ],
      ],
    });
    expect(one("model: gpt-5\n").template?.model).toBe("inherit");
    expect(one("model: sonnet\n")).toMatchObject({ template: { model: "standard" }, items: [] });
    expect(one("model: fable\n").template?.model).toBe("capable");
    // more than 3 skills are cut; a plugin-qualified name of this plugin is accepted
    expect(one("skills: [a1, b2, solo:c3, d4, Bad]\n")).toMatchObject({
      template: { skills: ["a1", "b2", "c3"] },
      items: [
        ["warnings", "agent", "a", "agents/a.md", "agent_skills_truncated", { skills: "d4, Bad" }],
      ],
    });
    expect(one("effort: high\nmaxTurns: 0\ncolor: red\n")).toMatchObject({
      template: { effort: "high" },
      items: [
        [
          "ignored",
          "agent",
          "a",
          "agents/a.md",
          "agent_field_ignored",
          { keys: "color, maxTurns" },
        ],
      ],
    });
    // no frontmatter, no description, a duplicate name
    const bad = translateClaudePlugin(
      withFiles(loadFixture("root-skill"), {
        "agents/x.md": "Just text.\n",
        "agents/y.md": "---\nname: y\n---\nBody.\n",
        "agents/z1.md": "---\nname: z\ndescription: Z.\n---\nOne.\n",
        "agents/z2.md": "---\nname: z\ndescription: Z.\n---\nTwo.\n",
      }),
      OPTS,
    );
    expect(codes(bad.report, "agent_invalid").map((r) => [r[2], r[3]])).toEqual([
      ["x", "agents/x.md"],
      ["y", "agents/y.md"],
      ["z", "agents/z2.md"],
    ]);
    expect(agentsOf(bad.tree).map((a) => a.template.instructions)).toEqual(["One.\n"]);
  });

  it("a plugin with only an agent imports; without one it is still refused", () => {
    const only = new Map([
      [".claude-plugin/plugin.json", Buffer.from(JSON.stringify({ name: "solo" }))],
      ["agents/a.md", Buffer.from("---\nname: a\ndescription: A.\n---\nBody.\n")],
    ]);
    expect(agentsOf(translateClaudePlugin(only, OPTS).tree).map((a) => a.name)).toEqual(["a"]);
    const none = new Map([
      [".claude-plugin/plugin.json", Buffer.from(JSON.stringify({ name: "solo" }))],
      ["agents/a.md", Buffer.from("no frontmatter")],
    ]);
    expect(refused(() => translateClaudePlugin(none, OPTS))).toContain("no skill");
  });
});
