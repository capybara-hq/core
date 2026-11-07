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
  SendMessage: "SendMessage",
  SubagentHandback: "SubagentHandback",
  TaskOutput: "TaskOutput",
  TaskStop: "TaskStop",
  WebSearch: "WebSearch",
  WebFetch: "WebFetch",
  Platform: "Platform",
  CurrentTime: "CurrentTime",
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
 * by the registry; `Agent` dispatches sub-agents and its description is built per agent;
 * `SendMessage` and `SubagentHandback` are added by the registry ({@link SUBAGENT_MESSAGE_TOOLS}).
 * `Platform` calls the platform's own operations as the run's person (Platform tool spec).
 * `CurrentTime` reads the clock (the run context carries only the date).
 */
export const BUILTIN_TOOL_NAMES: readonly BuiltinName[] = [
  BUILTIN.AskUserQuestion,
  BUILTIN.ReadToolOutput,
  BUILTIN.ToolSearch,
  BUILTIN.Skill,
  BUILTIN.SkillWrite,
  ...SANDBOX_TOOL_NAMES,
  BUILTIN.Agent,
  BUILTIN.SendMessage,
  BUILTIN.SubagentHandback,
  ...WEB_TOOL_NAMES,
  BUILTIN.Platform,
  BUILTIN.CurrentTime,
];

/** The builtin that loads a skill (added by the registry when the log has a skills catalog). */
export const SKILL_LOAD = BUILTIN.Skill;
/** The builtin that searches the tool catalog (added by the registry by org setting and threshold). */
export const TOOL_SEARCH = BUILTIN.ToolSearch;
/** The builtin that dispatches sub-agents. */
export const AGENT_TOOL = BUILTIN.Agent;
/** The builtin that sends a message to one of the caller's sub-agents or to its parent. */
export const SEND_MESSAGE = BUILTIN.SendMessage;
/** The builtin that hands a sub-agent's report back to its parent (sub-agents only). */
export const SUBAGENT_HANDBACK = BUILTIN.SubagentHandback;

/**
 * The tools between the agents of one tree (agent map spec §4.2, §4.3), added by the registry
 * whatever a definition names: `SendMessage` to an agent that has `Agent` or a parent, and
 * `SubagentHandback` to a sub-agent. A definition's ref to either is ignored.
 */
export const SUBAGENT_MESSAGE_TOOLS: ReadonlySet<string> = new Set<string>([
  SEND_MESSAGE,
  SUBAGENT_HANDBACK,
]);

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
 * `Platform` is on by default (Platform tool spec §3: reads are harmless, every write confirmed),
 * and so is `CurrentTime` (read-only, no side effects).
 */
export const DEFAULT_AGENT_TOOLS: AgentToolRef[] = [
  { kind: "builtin", name: BUILTIN.AskUserQuestion },
  { kind: "builtin", name: BUILTIN.ReadToolOutput },
  { kind: "builtin", name: BUILTIN.Platform },
  { kind: "builtin", name: BUILTIN.CurrentTime },
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
  [BUILTIN.SendMessage]: "meta",
  [BUILTIN.SubagentHandback]: "meta",
  [BUILTIN.WebSearch]: "search",
  [BUILTIN.WebFetch]: "read",
  [BUILTIN.Platform]: "tool",
  [BUILTIN.CurrentTime]: "tool",
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
