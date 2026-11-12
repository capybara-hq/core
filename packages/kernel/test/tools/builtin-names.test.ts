import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BUILTIN_TOOL_NAME_RE, type ModelInfo, type ModelRequest } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { reconstructRequest } from "../../src/evals/reconstruct.js";
import { type CaseSnapshot, toEvents } from "../../src/evals/snapshot.js";
import { buildModelRequest, type RequestTool } from "../../src/runtime/context/build.js";
import { CLAUDE_CODE_TOOL_MAP } from "../../src/runtime/context/claude-tools.js";
import {
  LEGACY_CATALOG_HEADER,
  LEGACY_SKILL_TEXTS,
  usesLegacyToolNames,
} from "../../src/runtime/context/legacy-text.js";
import {
  invokedSkillsText,
  pinnedSystemText,
  SKILL_TEXTS,
  skillsCatalogText,
  skillsChangeText,
  skillsCurrentText,
} from "../../src/runtime/context/skills.js";
import {
  AGENT_BUILTIN_NAMES,
  AGENT_TOOL,
  BUILTIN,
  BUILTIN_TOOL_KINDS,
  BUILTIN_TOOL_NAMES,
  CHILD_REMOVED_TOOLS,
  isRemovedBuiltinKey,
  R3_FIXED_ASK_TOOL_KEYS,
  SANDBOX_ASK_TOOL_NAMES,
  SANDBOX_TOOL_NAMES,
  SCHEDULE_TOOL_NAMES,
  WEB_TOOL_NAMES,
} from "../../src/tools/builtin-names.js";
import { agentToolSpec } from "../../src/tools/builtins/agent.js";
import { BuiltinTools } from "../../src/tools/builtins/builtin-tools.js";
import { CATALOG_HEADER, catalogText } from "../../src/tools/builtins/tool-search.js";
import { LEGACY_BUILTINS } from "../../src/tools/legacy-keys.js";
import { AGENT, Log, MODEL } from "../runtime/context/fixtures.js";

/** Tool naming spec §4.1: the builtins take Claude Code's names, in one module. */

const dummy = {} as never;
const builtins = () =>
  new BuiltinTools(
    dummy,
    dummy,
    dummy,
    dummy,
    dummy,
    dummy,
    dummy,
    dummy,
    dummy,
    dummy,
    dummy,
    dummy,
    dummy,
    dummy,
    dummy,
    dummy,
    dummy,
    dummy,
    dummy,
    dummy,
    dummy,
    dummy,
    dummy,
    dummy,
  ).list();

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
  it("there is no SkillWrite builtin: agents register skills with the Platform tool", () => {
    expect(BUILTIN_TOOL_NAMES).not.toContain("SkillWrite");
    expect(Object.keys(BUILTIN)).not.toContain("SkillWrite");
    expect(CHILD_REMOVED_TOOLS as readonly string[]).not.toContain("SkillWrite");
  });

  it("every BUILTIN value matches the builtin grammar and equals its key", () => {
    for (const [k, v] of Object.entries(BUILTIN)) {
      expect(v).toBe(k);
      expect(v).toMatch(BUILTIN_TOOL_NAME_RE);
    }
    expect(new Set(BUILTIN_TOOL_NAMES)).toEqual(new Set(Object.values(BUILTIN)));
    expect(BUILTIN_TOOL_NAMES).toHaveLength(Object.values(BUILTIN).length);
  });

  it("the sandbox lists name the nine sandbox tools, Deliver and the task tools included", () => {
    expect([...SANDBOX_TOOL_NAMES]).toEqual([
      "Bash",
      "Read",
      "Write",
      "Edit",
      "Glob",
      "Grep",
      "Deliver",
      "TaskOutput",
      "TaskStop",
      "TaskList",
    ]);
    // reading or stopping a task changes nothing the person has not already approved
    expect(SANDBOX_ASK_TOOL_NAMES.has("TaskOutput")).toBe(false);
    expect(SANDBOX_ASK_TOOL_NAMES.has("TaskStop")).toBe(false);
    expect(BUILTIN_TOOL_KINDS.TaskOutput).toBe("read");
    expect(BUILTIN_TOOL_KINDS.TaskStop).toBe("command");
    expect(SANDBOX_ASK_TOOL_NAMES.has("TaskList")).toBe(false);
    expect(BUILTIN_TOOL_KINDS.TaskList).toBe("read");
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
    // every builtin an agent can turn off, but Agent (the Sub-agents section switches it)
    expect(arrayLiteral(agents, "BUILTIN_TOOLS")).toEqual(
      AGENT_BUILTIN_NAMES.filter((n) => n !== AGENT_TOOL),
    );
    for (const f of [
      "apps/web/src/lib/timeline.ts",
      "apps/web/src/components/AgentSubagents.tsx",
    ]) {
      expect(stringConst(repoFile(f), "AGENT_TOOL"), f).toBe(AGENT_TOOL);
    }
  });

  it("WebSearch and WebFetch are builtin names with display kinds and a Claude Code map entry", () => {
    expect(BUILTIN.WebSearch).toBe("WebSearch");
    expect(BUILTIN.WebFetch).toBe("WebFetch");
    expect(WEB_TOOL_NAMES).toEqual(["WebSearch", "WebFetch"]);
    for (const n of WEB_TOOL_NAMES) expect(BUILTIN_TOOL_NAMES).toContain(n);
    expect(BUILTIN_TOOL_KINDS.WebSearch).toBe("search");
    expect(BUILTIN_TOOL_KINDS.WebFetch).toBe("read");
    expect(CLAUDE_CODE_TOOL_MAP).toContain(
      "Agent, SendMessage, WebFetch and WebSearch have the same names",
    );
    expect(CLAUDE_CODE_TOOL_MAP).not.toContain("resume");
    expect(CLAUDE_CODE_TOOL_MAP).not.toMatch(/for example WebFetch/);
  });

  it("the schedule tools: default-on, create and update fixed asks, removed from sub-agents", () => {
    expect([...SCHEDULE_TOOL_NAMES]).toEqual([
      "ScheduleCreate",
      "ScheduleUpdate",
      "ScheduleList",
      "ScheduleDelete",
    ]);
    for (const n of SCHEDULE_TOOL_NAMES) {
      expect(AGENT_BUILTIN_NAMES).toContain(n);
      expect(CHILD_REMOVED_TOOLS as readonly string[]).toContain(n);
      expect(BUILTIN_TOOL_KINDS[n]).toBe("tool");
    }
    // a person approves every task an agent creates or widens, on any agent (spec §11)
    expect(R3_FIXED_ASK_TOOL_KEYS.has("ScheduleCreate")).toBe(true);
    expect(R3_FIXED_ASK_TOOL_KEYS.has("ScheduleUpdate")).toBe(true);
    // listing reads, deleting one's own task only narrows
    expect(R3_FIXED_ASK_TOOL_KEYS.has("ScheduleList")).toBe(false);
    expect(R3_FIXED_ASK_TOOL_KEYS.has("ScheduleDelete")).toBe(false);
    const byName = new Map(builtins().map((t) => [t.spec.name, t]));
    expect(byName.get("ScheduleList")?.defaultPolicy).toBe("allow");
    expect(byName.get("ScheduleDelete")?.defaultPolicy).toBe("allow");
    expect(byName.get("ScheduleCreate")?.callPolicy).toBeTypeOf("function");
    expect(byName.get("ScheduleUpdate")?.callPolicy).toBeTypeOf("function");
  });

  it("the legacy map covers the 12 old names, one per new name (the task, web, message, Platform, CurrentTime and schedule tools never had one)", () => {
    expect(Object.keys(LEGACY_BUILTINS)).toHaveLength(12);
    const never: readonly string[] = [
      BUILTIN.TaskOutput,
      BUILTIN.TaskStop,
      BUILTIN.TaskList,
      BUILTIN.SendMessage,
      BUILTIN.SubagentHandback,
      ...WEB_TOOL_NAMES,
      BUILTIN.Platform,
      BUILTIN.CurrentTime,
      ...SCHEDULE_TOOL_NAMES,
    ];
    expect(new Set(Object.values(LEGACY_BUILTINS).map((l) => l.name))).toEqual(
      new Set(BUILTIN_TOOL_NAMES.filter((n) => !never.includes(n))),
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

/**
 * The frozen pre-rename texts, guarded independently of the constants: the expected strings are
 * literals copied byte for byte from `main` at 02b9634b (`runtime/context/skills.ts`,
 * `tools/builtins/tool-search.ts`). Editing a legacy text breaks old recordings' system hash.
 */
describe("legacy texts are the 02b9634b texts, byte for byte", () => {
  const s = (name: string, version = 1) => ({
    id: `id-${name}`,
    name,
    description: `Use for ${name}.`,
    version,
    source: `skills/${name}-v${version}/`,
  });
  const L = LEGACY_SKILL_TEXTS;

  it("skills catalog text", () => {
    expect(skillsCatalogText([s("beta"), s("alpha")], L)).toBe(
      "Skills are available in this conversation. A skill is a set of instructions, sometimes with scripts or other files, for a specific kind of task. When a task matches a skill's description, call skill_load with the skill's name to read its instructions before you start; do not guess what a skill says. Available skills:\n- alpha: Use for alpha.\n- beta: Use for beta.",
    );
  });

  it("change notices: new, updated, removed", () => {
    expect(
      skillsChangeText([s("alpha"), s("gone")], [s("alpha", 2), s("beta")], undefined, L),
    ).toBe(
      "The skills available in this conversation have changed.\n\nNew skills (call skill_load with the name to use one):\n- beta: Use for beta.\n\nUpdated skills (call skill_load again before relying on earlier instructions):\n- alpha: Use for alpha.\n\nRemoved skills (no longer available; do not use them): gone",
    );
  });

  it("current text after a compaction", () => {
    expect(skillsCurrentText([s("alpha")], L)).toBe(
      "Skills available in this conversation now (this replaces any earlier list of skills; call skill_load with a name to read a skill's instructions):\n- alpha: Use for alpha.",
    );
  });

  it("invoked skills line", () => {
    expect(invokedSkillsText(["brainstorm", "fix-issue"], L)).toBe(
      "Skills the user invoked earlier in this conversation: brainstorm, fix-issue. Call skill_load with a name to read its instructions again.",
    );
  });

  it("pinned system text", () => {
    const pinned = [
      { id: "id-a", name: "alpha", version: 3, source: "skills/a/", body: "Do X.\n" },
    ];
    expect(pinnedSystemText(pinned, L)).toBe(
      "Pinned skills: the owner of this agent pinned these skills, so their instructions apply throughout this conversation. Follow them without calling skill_load; call skill_load only to copy a pinned skill's files into the sandbox.\n\n" +
        '<pinned_skill name="alpha" version="3">\nDo X.\n</pinned_skill>',
    );
  });

  it("tool catalog header", () => {
    const t = {
      key: "mcp__docs__search",
      spec: { name: "x", description: "Search docs.\nMore.", inputSchema: {} },
    };
    expect(catalogText([t], LEGACY_CATALOG_HEADER)).toBe(
      "More tools are available but not loaded. To use one, first call tool_search with keywords; it returns the full definitions and loads the matching tools for your next step. Calling a tool that is not loaded returns an error. Tool catalog:\n- mcp__docs__search: Search docs.",
    );
  });
});

describe("isRemovedBuiltinKey", () => {
  it("is true only for a bare builtin-shaped key that names no current builtin", () => {
    expect(isRemovedBuiltinKey("SkillWrite")).toBe(true);
    for (const name of Object.values(BUILTIN)) expect(isRemovedBuiltinKey(name), name).toBe(false);
    for (const key of [
      "mcp__docs__search",
      "plugin__todo__write",
      "Platform:skills.share",
      "sandbox_bash",
    ]) {
      expect(isRemovedBuiltinKey(key), key).toBe(false);
    }
  });
});
