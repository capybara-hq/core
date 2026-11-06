import type { AgentToolRef } from "../agents/definition.js";
import type { ToolKind } from "./info.js";

/**
 * The names (model-visible keys) of the kernel's builtin tools, following Claude Code (tool naming
 * spec §4.1). Plain constants: `BuiltinTools`, the tool factories, the registry, policy and the
 * runtime import them from here. The web keeps its own copy (`apps/web/src/lib/agents.ts`,
 * `lib/timeline.ts`), checked equal by `test/tools/builtin-names.test.ts`. The release-candidate
 * names are in `legacy-keys.ts`, never here.
 */
export const BUILTIN = {
  Bash: "Bash",
  Read: "Read",
  Write: "Write",
  Edit: "Edit",
  Glob: "Glob",
  Grep: "Grep",
  Deliver: "Deliver",
  Skill: "Skill",
  SkillWrite: "SkillWrite",
  AskUserQuestion: "AskUserQuestion",
  ReadToolOutput: "ReadToolOutput",
  ToolSearch: "ToolSearch",
  Agent: "Agent",
  TaskOutput: "TaskOutput",
  TaskStop: "TaskStop",
  WebSearch: "WebSearch",
  WebFetch: "WebFetch",
} as const;

export type BuiltinName = (typeof BUILTIN)[keyof typeof BUILTIN];

/**
 * The builtin tools that run in the conversation's sandbox. `TaskOutput` and `TaskStop` read and
 * stop the background tasks `Bash` started (background Bash spec §2.2, §2.3).
 */
export const SANDBOX_TOOL_NAMES: readonly BuiltinName[] = [
  BUILTIN.Bash,
  BUILTIN.Read,
  BUILTIN.Write,
  BUILTIN.Edit,
  BUILTIN.Glob,
  BUILTIN.Grep,
  BUILTIN.Deliver,
  BUILTIN.TaskOutput,
  BUILTIN.TaskStop,
];

/** The builtin tools that reach the web through the org's web-search / web-fetch providers. */
export const WEB_TOOL_NAMES: readonly BuiltinName[] = [BUILTIN.WebSearch, BUILTIN.WebFetch];

/**
 * The tools offered with `Bash` whenever it is offered (background Bash: a model that can start a
 * background task can read and stop it). `ToolRegistry` adds them; an explicit ref is harmless.
 */
export const BASH_COMPANION_TOOLS: readonly BuiltinName[] = [BUILTIN.TaskOutput, BUILTIN.TaskStop];

/**
 * Sandbox tools that need approval when the org setting `sandboxToolPolicy` is `ask` (not the
 * read-only ones). Not `TaskOutput` or `TaskStop`: they only read or stop a task whose launch
 * already went through `Bash`'s policy (background Bash spec §4.5).
 */
export const SANDBOX_ASK_TOOL_NAMES: ReadonlySet<string> = new Set<string>([
  BUILTIN.Bash,
  BUILTIN.Write,
  BUILTIN.Edit,
  BUILTIN.Deliver,
]);

/**
 * Every builtin name. Saving an agent checks builtin refs against this list, not against what is
 * registered now, so the order the implementations land in never affects a saved definition.
 * `SkillWrite` is available only when a definition names it; `ToolSearch` and `Skill` are added
 * by the registry; `Agent` dispatches sub-agents and its description is built per agent.
 */
export const BUILTIN_TOOL_NAMES: readonly BuiltinName[] = [
  BUILTIN.AskUserQuestion,
  BUILTIN.ReadToolOutput,
  BUILTIN.ToolSearch,
  BUILTIN.Skill,
  BUILTIN.SkillWrite,
  ...SANDBOX_TOOL_NAMES,
  BUILTIN.Agent,
  ...WEB_TOOL_NAMES,
];

/** The builtin that loads a skill (added by the registry when the log has a skills catalog). */
export const SKILL_LOAD = BUILTIN.Skill;
/** The builtin that searches the tool catalog (added by the registry by org setting and threshold). */
export const TOOL_SEARCH = BUILTIN.ToolSearch;
/** The builtin that dispatches sub-agents. */
export const AGENT_TOOL = BUILTIN.Agent;

/**
 * Tool keys on the spec 3.6 R3 fixed list ("allowed is not confirmed"): their policy is at least
 * `ask` and remembered grants never let them through. `SkillWrite` changes shared skills.
 * Connector and extension tools express the same rule with `annotations.requiresUserInteraction`.
 */
export const R3_FIXED_ASK_TOOL_KEYS: ReadonlySet<string> = new Set<string>([BUILTIN.SkillWrite]);

/**
 * R3 keys that apply only to shared agents: a private agent's skills are not shared, so its
 * `SkillWrite` takes effect without asking (R4).
 */
export const R3_SHARED_AGENT_ONLY_TOOL_KEYS: ReadonlySet<string> = new Set<string>([
  BUILTIN.SkillWrite,
]);

/**
 * Tools a sub-agent never gets (sub-agents spec §5.3, §5.5): `AskUserQuestion` (the person does
 * not see the child), `Deliver` (delivering files is the parent's job) and `SkillWrite`. `Agent`
 * is removed only from a child at `subagents.maxDepth` (agent map spec §4.1, `effectiveDefinition`).
 */
export const CHILD_REMOVED_TOOLS = [
  BUILTIN.AskUserQuestion,
  BUILTIN.Deliver,
  BUILTIN.SkillWrite,
] as const;

/**
 * The tools of a new agent created without `tools` (`ToolSearch` is added by the registry, never
 * by a definition). Only for create requests; updates and stored versions get no defaults.
 */
export const DEFAULT_AGENT_TOOLS: AgentToolRef[] = [
  { kind: "builtin", name: BUILTIN.AskUserQuestion },
  { kind: "builtin", name: BUILTIN.ReadToolOutput },
];

/** Kinds of the builtin tools (display only); a builtin missing here is a plain `tool`. */
export const BUILTIN_TOOL_KINDS: Readonly<Record<string, ToolKind>> = {
  [BUILTIN.Bash]: "command",
  [BUILTIN.Read]: "read",
  [BUILTIN.Write]: "edit",
  [BUILTIN.Edit]: "edit",
  [BUILTIN.Glob]: "search",
  [BUILTIN.Grep]: "search",
  [BUILTIN.Deliver]: "tool",
  [BUILTIN.TaskOutput]: "read",
  [BUILTIN.TaskStop]: "command",
  [BUILTIN.ToolSearch]: "meta",
  [BUILTIN.Skill]: "meta",
  [BUILTIN.SkillWrite]: "meta",
  [BUILTIN.ReadToolOutput]: "meta",
  [BUILTIN.AskUserQuestion]: "meta",
  [BUILTIN.WebSearch]: "search",
  [BUILTIN.WebFetch]: "read",
};

/**
 * Input fields left out when matching a replayed call with a recorded one (full-run replay), per
 * tool: display-only arguments the model writes that do not change what the tool does. `Bash`'s
 * `description` became required in UI refresh B, so a recording without it and a replayed call
 * with one (or a different wording) still match.
 */
export const MATCH_IGNORED_FIELDS: Readonly<Record<string, readonly string[]>> = {
  // `run_in_background` is matched on purpose: it changes what the call did (a launch that
  // returns at once instead of the command's output; background Bash spec §4.4)
  [BUILTIN.Bash]: ["description"],
};
