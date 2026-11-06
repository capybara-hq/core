import type { ToolSpec } from "@capybara-hq/plugin-sdk";
import { z } from "zod";
import type { BuiltinTool } from "../registry.js";

export { SEND_MESSAGE } from "../builtin-names.js";

/**
 * The `SendMessage` builtin tool (agent map spec §4.2, §5.1, §5.2): moves text between the agents
 * of one tree. An agent sends to one of its own sub-agents by agentId (a running one reads it at its
 * next step, an idle one starts again with its earlier context), and a sub-agent to `"parent"`.
 * The result says the message was delivered, never the target's reply. The tool pipeline handles
 * the call itself (`SubagentMessages`), so {@link sendMessageTool}'s `run` is only a guard.
 */

/** The input of a `SendMessage` call. */
export const SendMessageInput = z
  .object({
    to: z.string().min(1).max(64),
    message: z.string().min(1).max(100_000),
  })
  .strict();
export type SendMessageInputT = z.infer<typeof SendMessageInput>;

/** The target a sub-agent uses for the agent that dispatched it. */
export const PARENT_TARGET = "parent";

const SPEC: ToolSpec = {
  name: "SendMessage",
  description:
    "Send a message to another agent of this conversation. To reach one of your sub-agents, pass " +
    "its agentId (from the Agent result) as to: a sub-agent that is working reads the message at " +
    "its next step, and one that already finished starts working again with its earlier context. " +
    'A sub-agent can pass "parent" as to, to send a note to the agent that dispatched it. This ' +
    "tool only delivers the message and returns at once; it never waits for a reply. Replies, " +
    "reports and finishes arrive later in this conversation as notifications. A sub-agent hands " +
    "back its final report with SubagentHandback, not with this tool.",
  inputSchema: {
    type: "object",
    properties: {
      to: {
        type: "string",
        minLength: 1,
        maxLength: 64,
        description: 'The agentId of one of your sub-agents, or "parent" in a sub-agent.',
      },
      message: {
        type: "string",
        minLength: 1,
        maxLength: 100000,
        description:
          "The message. The receiving agent sees only this text, so include everything it needs.",
      },
    },
    required: ["to", "message"],
    additionalProperties: false,
  },
  // display only (UI refresh B): who the message goes to; never sent to the model
  keyArgs: ["to"],
};

/** `12345` → `12,345` (no locale data involved, so the text is the same on every replica). */
const count = (n: number): string => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** One valid target of a caller: a sub-agent of its own, by agentId and task label. */
export interface SendTarget {
  id: string;
  description: string;
}

/** How a target is listed in a refusal. */
const targetLine = (t: SendTarget): string => `${t.id} (${JSON.stringify(t.description)})`;

/** Refusals: `isError` results written without delivering anything (model-visible). */
export const SEND_MESSAGE_REFUSALS = {
  /**
   * `to` is none of the caller's own sub-agents (nor `"parent"` in a sub-agent): lists the valid
   * targets, at most the newest {@link SEND_TARGETS_LISTED} sub-agents.
   */
  unknownTarget: (
    to: string,
    targets: readonly SendTarget[],
    opts: { hasParent: boolean; more: number },
  ): string => {
    const lines = [
      ...targets.map(targetLine),
      ...(opts.hasParent ? [`"${PARENT_TARGET}" (the agent that dispatched you)`] : []),
    ];
    if (lines.length === 0) {
      return `There is no agent "${to}" to send to: you have no sub-agents yet. Use Agent to dispatch one.`;
    }
    const more = opts.more > 0 ? `, and ${opts.more} older sub-agents` : "";
    return `There is no agent "${to}" you can send to. Pass one of these as to: ${lines.join(", ")}${more}.`;
  },
  /** The sub-agent's type or org agent is no longer available to the caller (its gates). */
  notAvailable: (id: string, type: string): string =>
    `Sub-agent ${id} can no longer receive messages: its agent type "${type}" is not available to you any more. Use Agent to dispatch another sub-agent instead.`,
  /** The limits of a send that would start an idle sub-agent again (agent map spec §6). */
  tooManyConcurrent: (n: number): string =>
    `At most ${n} of your sub-agents can run at once in this conversation, and this one has finished; send the message again after one of the running sub-agents finishes.`,
  tooManyDispatches: (n: number): string =>
    `${n} sub-agents have been dispatched or restarted since the user's latest message, counted across all levels of sub-agents; that is the limit, so this finished sub-agent cannot start again. Do the remaining work yourself.`,
  budget: (n: number): string =>
    `Sub-agents have used their token budget since the user's latest message (${count(n)} tokens, counted across all levels of sub-agents), so this finished sub-agent cannot start again. Do the remaining work yourself.`,
  depthLimit: (maxDepth: number): string =>
    `Sub-agents can be nested at most ${maxDepth} levels deep and you are at the deepest level, so this finished sub-agent cannot start again. Do the remaining work yourself.`,
  notAvailableHere: "Messages between agents are not available in this conversation.",
} as const;

/** How many of the caller's sub-agents an unknown-target refusal lists (the newest). */
export const SEND_TARGETS_LISTED = 20;

/** The result of a message to a sub-agent whose run was active (agent map spec §5.1). */
export const sentToRunningText = (t: SendTarget): string =>
  `Message delivered to sub-agent ${targetLine(t)}, which is working; it reads the message at its next step. Its reply or report arrives later as a notification; keep working or end your turn.`;

/** The result of a message that started an idle sub-agent again (agent map spec §5.1, §6). */
export const sentToIdleText = (t: SendTarget): string =>
  `Message delivered to sub-agent ${targetLine(t)}, which had finished; it is working again with its earlier context. Its reply or report arrives later as a notification; keep working or end your turn.`;

/** The result of a sub-agent's note to its parent (agent map spec §5.2). */
export const SENT_TO_PARENT_TEXT =
  "Message delivered to the agent that dispatched you. Keep working; its reply, if any, arrives as a message in this conversation.";

/**
 * The builtin. `defaultPolicy: "allow"` (agent map spec §4.2): it only moves text inside one tree
 * the person already started. The tool pipeline handles `SendMessage` calls itself; `run` answers
 * only when a call reaches it anyway.
 */
export const sendMessageTool: BuiltinTool = {
  spec: SPEC,
  defaultPolicy: "allow",
  run: async () => ({
    content: [{ type: "text", text: SEND_MESSAGE_REFUSALS.notAvailableHere }],
    isError: true,
  }),
};
