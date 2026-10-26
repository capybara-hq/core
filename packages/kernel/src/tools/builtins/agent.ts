import type { AgentTemplateTier, ToolSpec } from "@capybara-hq/plugin-sdk";
import { z } from "zod";
import type { EventPayload } from "../../conversations/events.js";
import { ROSTER_DESCRIPTION_MAX, type RosterEntry } from "../../runtime/subagents/roster.js";
import type { BuiltinTool } from "../registry.js";

/**
 * The `agent` builtin tool (sub-agents spec §4): dispatches a sub-agent. Its description is built
 * per parent agent version from the roster ({@link agentToolSpec}); the tool pipeline handles the
 * call itself (dispatch, suspend, resume), so {@link agentTool}'s `run` is only a guard.
 */
export const AGENT_TOOL = "agent";

/** How a sub-agent's run ended (`subagent_finished.status`). */
export type SubagentStatus = EventPayload<"subagent_finished">["status"];

/** The input of an `agent` call (§4.2). */
export const AgentToolInput = z
  .object({
    description: z.string().min(1).max(80),
    prompt: z.string().min(1).max(100_000),
    subagent_type: z.string().min(1).max(130).optional(),
    model: z.enum(["inherit", "fast", "standard", "capable"]).optional(),
    resume: z.string().max(64).optional(),
  })
  .strict() satisfies z.ZodType<{
  description: string;
  prompt: string;
  subagent_type?: string | undefined;
  model?: AgentTemplateTier | undefined;
  resume?: string | undefined;
}>;
export type AgentToolInputT = z.infer<typeof AgentToolInput>;

const INPUT_SCHEMA: ToolSpec["inputSchema"] = {
  type: "object",
  properties: {
    description: {
      type: "string",
      minLength: 1,
      maxLength: 80,
      description: "A short label for the task (3 to 6 words), shown to the user.",
    },
    prompt: {
      type: "string",
      minLength: 1,
      maxLength: 100000,
      description:
        "The complete task for the sub-agent. It sees nothing else of this conversation: include " +
        "every fact, file path and constraint it needs, and say what its final reply must contain.",
    },
    subagent_type: {
      type: "string",
      minLength: 1,
      maxLength: 130,
      description:
        "Which agent type to run, from the list in this tool's description. Defaults to " +
        "general-purpose.",
    },
    model: {
      type: "string",
      enum: ["inherit", "fast", "standard", "capable"],
      description:
        "Model tier for this sub-agent: fast and cheap for mechanical work, standard for " +
        "integration and judgment, capable for design and final reviews. Defaults to the agent " +
        "type's own setting, else your model.",
    },
    resume: {
      type: "string",
      maxLength: 64,
      description:
        "The agentId from an earlier result of this tool: sends prompt to that sub-agent as a " +
        "follow-up, with its earlier context intact. Leave subagent_type and model unset.",
    },
  },
  required: ["description", "prompt"],
  additionalProperties: false,
};

/** The text before the roster (§4.3), with the concurrency limit. */
const head = (maxConcurrent: number): string =>
  "Dispatch a sub-agent: a fresh agent with its own context that works on one task and returns its " +
  "final reply as this tool's result. The sub-agent sees only your prompt, not this conversation, so " +
  "include everything it needs and say what its final reply must contain. It shares your sandbox " +
  "files. You wait until it finishes. To run several at once, call this tool several times in the " +
  `same response (at most ${maxConcurrent} at a time); their commands run in the sandbox at the ` +
  "same time, so give parallel sub-agents separate files or directories. Sub-agents cannot " +
  "dispatch sub-agents or ask the user questions. To send a finished sub-agent a follow-up while " +
  "keeping its context, pass the agentId from its result as resume.\n" +
  "\n" +
  "Agent types (subagent_type):\n";

/**
 * Roster text from owners and plugins, made inert (batch 1 review M1): whitespace runs (newlines
 * included) become one space, so an entry stays one line and cannot add entries or sections, and
 * `<` / `>` become `‹` / `›`, so no tag can be opened or closed (Claude agent descriptions carry
 * `<example>` blocks; they stay readable). Length-preserving apart from the whitespace.
 */
const inert = (s: string): string =>
  s.replace(/\s+/g, " ").trim().replaceAll("<", "‹").replaceAll(">", "›");

function rosterLine(e: RosterEntry): string {
  const description = inert(e.description).slice(0, ROSTER_DESCRIPTION_MAX);
  const line = `- ${inert(e.type)}: ${description}`;
  if (e.source !== "agent") return line;
  return e.agentName === undefined
    ? `${line} (another agent, with its own tools and model)`
    : `${line} (the agent "${inert(e.agentName).replaceAll('"', "'")}", with its own tools and model)`;
}

/**
 * The `agent` tool definition of a parent agent version (§4.3): the fixed text with
 * `maxConcurrent`, then one line per roster entry in roster order. Built at tool resolution, so the
 * spec hash changes with the roster or the limit (logged per request in `tool_specs`).
 */
export function agentToolSpec(roster: readonly RosterEntry[], maxConcurrent: number): ToolSpec {
  return {
    name: AGENT_TOOL,
    description: head(maxConcurrent) + roster.map(rosterLine).join("\n"),
    inputSchema: INPUT_SCHEMA,
  };
}

/**
 * The static definition: the rendering for a roster of only general-purpose at the default
 * `subagents.maxConcurrentPerRun` (what an agent without `subagents` gets under the defaults).
 * Written out as a literal for the tool design check; a test pins it equal to
 * `agentToolSpec([general-purpose], 4)`.
 */
const SPEC: ToolSpec = {
  name: "agent",
  description:
    "Dispatch a sub-agent: a fresh agent with its own context that works on one task and returns its " +
    "final reply as this tool's result. The sub-agent sees only your prompt, not this conversation, so " +
    "include everything it needs and say what its final reply must contain. It shares your sandbox " +
    "files. You wait until it finishes. To run several at once, call this tool several times in the " +
    "same response (at most 4 at a time); their commands run in the sandbox at the same time, so give " +
    "parallel sub-agents separate files or directories. Sub-agents cannot dispatch sub-agents or ask " +
    "the user questions. To send a finished sub-agent a follow-up while keeping its context, pass the " +
    "agentId from its result as resume.\n" +
    "\n" +
    "Agent types (subagent_type):\n" +
    "- general-purpose: a copy of you with your tools and skills, for multi-step work.",
  inputSchema: INPUT_SCHEMA,
};

/** Refusals (§4.5): `isError` results written without starting anything (model-visible). */
export const AGENT_REFUSALS = {
  unknownType: (x: string, roster: readonly string[]): string =>
    `Unknown subagent_type "${x}". Available: ${roster.join(", ")}.`,
  tooManyConcurrent: (n: number): string =>
    `At most ${n} sub-agents can run at once in this run; dispatch the remaining tasks after these finish.`,
  tooManyDispatches: (n: number): string =>
    `This run has dispatched ${n} sub-agents, the limit; do the remaining work yourself.`,
  budget: (n: number): string =>
    `Sub-agents of this run have used their token budget (${count(n)} tokens); do the remaining work yourself.`,
  noSuchAgent: (id: string): string => `No sub-agent with agentId "${id}" in this conversation.`,
  stillRunning: (id: string): string =>
    `Sub-agent "${id}" is still running; wait for its result before sending a follow-up.`,
  resumeWithType: "resume cannot be combined with subagent_type or model.",
  notAvailableHere: "Sub-agents are not available in this conversation.",
  agentNotAvailable: (name: string): string =>
    `The agent "${name}" is not available to the person who started this conversation; do this task yourself or use another agent type.`,
} as const;

/** `12345` → `12,345` (no locale data involved, so the text is the same on every replica). */
const count = (n: number): string => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** `4s`, `1m 05s`, `1h 02m`. */
function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

/**
 * The tool result of a finished sub-agent (§4.4): the text for how its run ended, a blank line, and
 * the status line with its `agentId`. `ownModel`: an org agent dispatched with a `model` that was
 * ignored. `abortedBy: "parent"`: stopped together with the parent run (seen only in logs).
 */
export function agentResultText(r: {
  reply: string;
  agentId: string;
  status: SubagentStatus;
  errorCode?: string;
  errorMessage?: string;
  toolCalls: number;
  durationMs: number;
  tokens: number;
  ownModel?: boolean;
  abortedBy?: "user" | "parent";
}): { content: string; isError: boolean } {
  const reply = r.reply.trim();
  let status: string;
  let text: string;
  let isError = true;
  switch (r.status) {
    case "completed":
      [status, text, isError] = ["completed", reply, false];
      break;
    case "max_steps":
      [status, text, isError] = [
        "stopped at the step limit; the reply may be partial",
        reply,
        false,
      ];
      break;
    case "max_duration":
      status = "stopped at the time limit; the reply may be partial";
      text = reply === "" ? "The sub-agent produced no reply before the time limit." : reply;
      isError = false;
      break;
    case "budget":
      [status, text] = ["stopped: token budget used up", reply];
      break;
    case "aborted":
      [status, text] =
        r.abortedBy === "parent"
          ? [
              "stopped with this run",
              "The run was stopped while this sub-agent was working; it was stopped too.",
            ]
          : ["stopped by the user", "The user stopped this sub-agent."];
      break;
    case "timed_out":
      // the parent's sub-agents wait timed out (§7.2) and stopped it; the parent goes on
      [status, text] = ["timed out", "stopped: the sub-agent wait timed out"];
      break;
    case "failed":
      status = r.errorCode === undefined ? "failed" : `failed (${r.errorCode})`;
      text =
        r.errorMessage === undefined
          ? "The sub-agent failed."
          : `The sub-agent failed: ${r.errorMessage}`;
      break;
  }
  const parts = [
    `agentId: ${r.agentId}`,
    status,
    ...(r.ownModel === true ? ["model: the agent's own"] : []),
    `${r.toolCalls} tool ${r.toolCalls === 1 ? "call" : "calls"}`,
    duration(r.durationMs),
    `${count(r.tokens)} tokens. Pass the agentId as resume to send this sub-agent a follow-up.`,
  ];
  const line = `[${parts.join(" · ")}]`;
  return { content: text === "" ? line : `${text}\n\n${line}`, isError };
}

/**
 * The builtin. `defaultPolicy: "allow"` (§4.6): a sub-agent runs only tools its parent may run,
 * each under its own policy. The tool pipeline dispatches `agent` calls itself; `run` answers only
 * when a call reaches it anyway.
 */
export const agentTool: BuiltinTool = {
  spec: SPEC,
  defaultPolicy: "allow",
  run: async () => ({
    content: [{ type: "text", text: AGENT_REFUSALS.notAvailableHere }],
    isError: true,
  }),
};
