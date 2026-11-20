import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BUILTIN_TOOL_NAME_RE, type ModelRequest } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { buildModelRequest, type RequestTool } from "../../src/runtime/context/build.js";
import { CLAUDE_CODE_TOOL_MAP } from "../../src/runtime/context/claude-tools.js";
import { invokedSkillsText, SKILL_TEXTS } from "../../src/runtime/context/skills.js";
import {
  AGENT_BUILTIN_NAMES,
  AGENT_TOOL,
  BUILTIN,
  BUILTIN_TOOL_KINDS,
  BUILTIN_TOOL_NAMES,
  CHILD_REMOVED_TOOLS,
  R3_FIXED_ASK_TOOL_KEYS,
  SANDBOX_ASK_TOOL_NAMES,
  SANDBOX_TOOL_NAMES,
  SCHEDULE_TOOL_NAMES,
  WEB_TOOL_NAMES,
} from "../../src/tools/builtin-names.js";
import { agentToolSpec } from "../../src/tools/builtins/agent.js";
import { BuiltinTools } from "../../src/tools/builtins/builtin-tools.js";
import { CATALOG_HEADER } from "../../src/tools/builtins/tool-search.js";
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

  it("the sandbox lists name the sandbox tools, Deliver, FetchAttachment and the task tools included", () => {
    expect([...SANDBOX_TOOL_NAMES]).toEqual([
      "Bash",
      "Read",
      "Write",
      "Edit",
      "Glob",
      "Grep",
      "Deliver",
      "FetchAttachment",
      "TaskOutput",
      "TaskStop",
      "TaskList",
    ]);
    // reading or stopping a task changes nothing the person has not already approved
    expect(SANDBOX_ASK_TOOL_NAMES.has("TaskOutput")).toBe(false);
    expect(SANDBOX_ASK_TOOL_NAMES.has("TaskStop")).toBe(false);
    expect(BUILTIN_TOOL_KINDS.TaskOutput).toBe("task");
    expect(BUILTIN_TOOL_KINDS.TaskStop).toBe("command");
    expect(SANDBOX_ASK_TOOL_NAMES.has("TaskList")).toBe(false);
    expect(BUILTIN_TOOL_KINDS.TaskList).toBe("task");
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
      "ScheduleTargets",
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
    expect(R3_FIXED_ASK_TOOL_KEYS.has("ScheduleTargets")).toBe(false);
    expect(R3_FIXED_ASK_TOOL_KEYS.has("ScheduleDelete")).toBe(false);
    const byName = new Map(builtins().map((t) => [t.spec.name, t]));
    expect(byName.get("ScheduleList")?.defaultPolicy).toBe("allow");
    expect(byName.get("ScheduleTargets")?.defaultPolicy).toBe("allow");
    expect(byName.get("ScheduleDelete")?.defaultPolicy).toBe("allow");
    expect(byName.get("ScheduleCreate")?.callPolicy).toBeTypeOf("function");
    expect(byName.get("ScheduleUpdate")?.callPolicy).toBeTypeOf("function");
  });
});

describe("system texts naming builtins (tool naming spec §10)", () => {
  const tool = (key: string): RequestTool => ({
    key,
    specHash: `h-${key}`,
    spec: { name: key, description: `The ${key} tool.`, inputSchema: { type: "object" } },
  });
  const skill = { id: "s1", name: "alpha", description: "Alpha.", version: 1, source: "skills/a/" };

  /** A log with a system catalog and a later snapshot with a new skill. */
  function log(): ConversationEvent[] {
    const l = new Log();
    l.user("hi");
    l.runStarted();
    l.add({
      type: "skills_catalog",
      payload: { skills: [skill] },
    });
    l.modelCall(1);
    l.assistant("ok");
    l.user("again");
    l.add({
      type: "skills_catalog",
      payload: { skills: [skill, { ...skill, id: "s2", name: "beta" }] },
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

  it("a request with the new builtins renders the new names", () => {
    const text = texts(build([tool("Skill"), tool("ToolSearch"), tool("mcp__docs__search")]));
    expect(text).toContain(SKILL_TEXTS.skillsCatalogHeader);
    expect(text).toContain(SKILL_TEXTS.newSkills);
    expect(text).toContain(CATALOG_HEADER);
    expect(text).toContain("call Skill with");
    expect(text).toContain("call ToolSearch first with");
    expect(text).not.toMatch(/skill_load|tool_search/);
  });
});

describe("the compaction line for invoked skills", () => {
  it("names the skills without claiming the user invoked them (template skills are kernel-written)", () => {
    expect(invokedSkillsText([])).toBe("");
    expect(invokedSkillsText(["brainstorm", "fix-issue"])).toBe(
      "Skills invoked earlier in this conversation: brainstorm, fix-issue. Call Skill with a name to read its instructions again.",
    );
  });
});
