import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BUILTIN_TOOL_NAME_RE, type ModelInfo, type ModelRequest } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { reconstructRequest } from "../../src/evals/reconstruct.js";
import { type CaseSnapshot, toEvents } from "../../src/evals/snapshot.js";
import { buildModelRequest, type RequestTool } from "../../src/runtime/context/build.js";
import {
  LEGACY_CATALOG_HEADER,
  LEGACY_SKILL_TEXTS,
  usesLegacyToolNames,
} from "../../src/runtime/context/legacy-text.js";
import { SKILL_TEXTS } from "../../src/runtime/context/skills.js";
import {
  AGENT_TOOL,
  BUILTIN,
  BUILTIN_TOOL_NAMES,
  DEFAULT_AGENT_TOOLS,
  SANDBOX_ASK_TOOL_NAMES,
  SANDBOX_TOOL_NAMES,
} from "../../src/tools/builtin-names.js";
import { agentToolSpec } from "../../src/tools/builtins/agent.js";
import { BuiltinTools } from "../../src/tools/builtins/builtin-tools.js";
import { CATALOG_HEADER } from "../../src/tools/builtins/tool-search.js";
import { LEGACY_BUILTINS } from "../../src/tools/legacy-keys.js";
import { AGENT, Log, MODEL } from "../runtime/context/fixtures.js";

/** Tool naming spec §4.1: the builtins take Claude Code's names, in one module. */

const dummy = {} as never;
const builtins = () =>
  new BuiltinTools(dummy, dummy, dummy, dummy, dummy, dummy, dummy, dummy).list();

const repoFile = (path: string) =>
  readFileSync(fileURLToPath(new URL(`../../../../${path}`, import.meta.url)), "utf8");

/** The string array literal assigned to `name` in a source file. */
function arrayLiteral(src: string, name: string): string[] {
  const m = new RegExp(`export const ${name}\\b[^=]*=\\s*\\[([^\\]]*)\\]`).exec(src);
  if (!m) throw new Error(`${name} not found`);
  return [...(m[1] as string).matchAll(/"([^"]+)"/g)].map((x) => x[1] as string);
}

/** The string constant assigned to `name` in a source file. */
function stringConst(src: string, name: string): string {
  const m = new RegExp(`export const ${name} = "([^"]+)"`).exec(src);
  if (!m) throw new Error(`${name} not found`);
  return m[1] as string;
}

/** Old names that must not appear in model-visible builtin text. */
const OLD_NAMES: readonly RegExp[] = [
  /\bsandbox_/,
  /\bskill_load\b/,
  /\bskill_write\b/,
  /\btool_search\b/,
  /\bask_user\b/,
  /\bread_tool_output\b/,
  // `agent` as a tool name (the word itself is fine: "a sub-agent", "this agent")
  /`agent`/,
  /"agent"/,
  /\b(call|use|through|with|via) agent\b/,
  /\bagent tool\b/,
];

describe("builtin names", () => {
  it("every BUILTIN value matches the builtin grammar and equals its key", () => {
    for (const [k, v] of Object.entries(BUILTIN)) {
      expect(v).toBe(k);
      expect(v).toMatch(BUILTIN_TOOL_NAME_RE);
    }
    expect(new Set(BUILTIN_TOOL_NAMES)).toEqual(new Set(Object.values(BUILTIN)));
    expect(BUILTIN_TOOL_NAMES).toHaveLength(Object.values(BUILTIN).length);
  });

  it("the sandbox lists name the seven sandbox tools, Deliver included", () => {
    expect([...SANDBOX_TOOL_NAMES]).toEqual([
      "Bash",
      "Read",
      "Write",
      "Edit",
      "Glob",
      "Grep",
      "Deliver",
    ]);
    expect([...SANDBOX_ASK_TOOL_NAMES]).toEqual(["Bash", "Write", "Edit", "Deliver"]);
  });

  it("the tools BuiltinTools builds are exactly BUILTIN_TOOL_NAMES", () => {
    const names = builtins().map((t) => t.spec.name);
    for (const n of names) expect(BUILTIN_TOOL_NAMES as readonly string[]).toContain(n);
    expect(new Set(names)).toEqual(new Set(BUILTIN_TOOL_NAMES));
    expect(names).toHaveLength(BUILTIN_TOOL_NAMES.length);
  });

  it("no builtin description or schema names an old builtin", () => {
    const specs = [
      ...builtins().map((t) => t.spec),
      agentToolSpec(
        [{ type: "general-purpose", description: "A copy of you.", source: "general" }],
        4,
      ),
    ];
    for (const spec of specs) {
      const text = `${spec.description}\n${JSON.stringify(spec.inputSchema)}`;
      for (const re of OLD_NAMES) expect(text, `${spec.name}: ${re}`).not.toMatch(re);
    }
  });

  it("the web copies name the builtins under their new names", () => {
    const agents = repoFile("apps/web/src/lib/agents.ts");
    expect(arrayLiteral(agents, "BUILTIN_TOOLS")).toEqual([
      BUILTIN.AskUserQuestion,
      BUILTIN.ReadToolOutput,
      BUILTIN.SkillWrite,
    ]);
    expect(arrayLiteral(agents, "DEFAULT_BUILTIN_TOOLS")).toEqual(
      DEFAULT_AGENT_TOOLS.map((r) => (r.kind === "builtin" ? r.name : "")),
    );
    for (const f of [
      "apps/web/src/lib/timeline.ts",
      "apps/web/src/components/AgentSubagents.tsx",
    ]) {
      expect(stringConst(repoFile(f), "AGENT_TOOL"), f).toBe(AGENT_TOOL);
    }
  });

  it("the legacy map covers the 13 old names, one per new name", () => {
    expect(Object.keys(LEGACY_BUILTINS)).toHaveLength(13);
    expect(new Set(Object.values(LEGACY_BUILTINS).map((l) => l.name))).toEqual(
      new Set(BUILTIN_TOOL_NAMES),
    );
    expect(LEGACY_BUILTINS.sandbox_bash).toEqual({
      name: "Bash",
      params: { timeoutSeconds: "timeout" },
      msParams: ["timeout"],
    });
    expect(LEGACY_BUILTINS.skill_load?.params).toEqual({ name: "skill" });
    expect(LEGACY_BUILTINS.tool_search?.params).toEqual({ limit: "max_results" });
  });
});

describe("system texts naming builtins (tool naming spec §10)", () => {
  const tool = (key: string): RequestTool => ({
    key,
    specHash: `h-${key}`,
    spec: { name: key, description: `The ${key} tool.`, inputSchema: { type: "object" } },
  });
  const skill = { id: "s1", name: "alpha", description: "Alpha.", version: 1, source: "skills/a/" };

  /** A log with a system catalog, a later snapshot with a new skill, and pinned skills. */
  function log(): ConversationEvent[] {
    const l = new Log();
    l.user("hi");
    l.runStarted();
    l.add({
      type: "skills_catalog",
      payload: {
        skills: [skill],
        pinned: [{ id: "s1", name: "alpha", version: 1, source: "skills/a/", body: "Pinned." }],
      },
    });
    l.modelCall(1);
    l.assistant("ok");
    l.user("again");
    l.add({
      type: "skills_catalog",
      payload: {
        skills: [skill, { ...skill, id: "s2", name: "beta" }],
        pinned: [{ id: "s1", name: "alpha", version: 1, source: "skills/a/", body: "Pinned." }],
      },
    });
    return l.events;
  }
  const build = (tools: RequestTool[]) =>
    buildModelRequest({
      events: log(),
      agent: AGENT,
      agentVersion: 1,
      model: MODEL,
      step: 1,
      tools,
      toolSearch: true,
    }).request;
  const texts = (r: ModelRequest) =>
    [
      ...r.system.map((s) => s.text),
      ...r.messages.flatMap((m) => (m.role === "system" ? [m.content as string] : [])),
    ].join("\n");

  it("usesLegacyToolNames is true exactly when a tool key is a release-candidate builtin", () => {
    expect(usesLegacyToolNames([{ key: "skill_load" }, { key: "mcp__docs__search" }])).toBe(true);
    expect(usesLegacyToolNames([{ key: "agent" }])).toBe(true);
    expect(usesLegacyToolNames([{ key: "Skill" }, { key: "docs__search" }])).toBe(false);
    expect(usesLegacyToolNames([])).toBe(false);
  });

  it("a request with the new builtins renders the new names", () => {
    const text = texts(build([tool("Skill"), tool("ToolSearch"), tool("mcp__docs__search")]));
    expect(text).toContain(SKILL_TEXTS.skillsCatalogHeader);
    expect(text).toContain(SKILL_TEXTS.pinnedSkillsHeader);
    expect(text).toContain(SKILL_TEXTS.newSkills);
    expect(text).toContain(CATALOG_HEADER);
    expect(text).toContain("call Skill with");
    expect(text).toContain("call ToolSearch with");
    expect(text).not.toMatch(/skill_load|tool_search/);
  });

  it("a request recorded with the old builtins renders the frozen pre-rename texts", () => {
    const r = build([tool("skill_load"), tool("tool_search"), tool("docs__search")]);
    const text = texts(r);
    expect(text).toContain(LEGACY_SKILL_TEXTS.skillsCatalogHeader);
    expect(text).toContain(LEGACY_SKILL_TEXTS.pinnedSkillsHeader);
    expect(text).toContain(LEGACY_SKILL_TEXTS.newSkills);
    expect(text).toContain(LEGACY_CATALOG_HEADER);
    expect(text).not.toMatch(/call Skill|ToolSearch/);
    // the old builtins are still sent in full, not in the catalog
    expect(r.tools?.map((t) => t.name)).toEqual(["skill_load", "tool_search"]);
  });

  it("the pre-rename fixture rebuilds with the legacy catalog header and no drift", () => {
    type Fixture = { model: ModelInfo; snapshot: CaseSnapshot; requests: ModelRequest[] };
    const fixture = JSON.parse(
      repoFile("packages/kernel/test/evals/fixtures/pre-rename/mcp-conversation.json"),
    ) as Fixture;
    const calls = toEvents(fixture.snapshot).filter((e) => e.type === "model_call");
    let sawCatalog = false;
    for (const [i, c] of calls.entries()) {
      const out = reconstructRequest(fixture.snapshot, c.seq, { model: fixture.model });
      expect(out.drift).toEqual([]);
      expect(out.request).toEqual(fixture.requests[i]);
      if (out.request.system.some((s) => s.text.startsWith(LEGACY_CATALOG_HEADER))) {
        sawCatalog = true;
      }
    }
    expect(sawCatalog).toBe(true);
  });
});
