import type { ToolSpec } from "@capybara-hq/plugin-sdk";
import { z } from "zod";
import type { BuiltinTool } from "../registry.js";

export { SUBAGENT_HANDBACK } from "../builtin-names.js";

/**
 * The `SubagentHandback` builtin tool (agent map spec §4.3, children only): delivers a report to
 * the agent that dispatched the sub-agent, as a `report` `subagent_delivery` in the parent's log.
 * The sub-agent keeps its turn and may go on working; several handbacks are allowed, and a finish
 * after one is delivered as a one-line status. The tool pipeline handles the call itself
 * (`SubagentMessages`), so {@link handbackTool}'s `run` is only a guard.
 */

/** The input of a `SubagentHandback` call. */
export const HandbackInput = z.object({ message: z.string().min(1).max(200_000) }).strict();
export type HandbackInputT = z.infer<typeof HandbackInput>;

const SPEC: ToolSpec = {
  name: "SubagentHandback",
  description:
    "Hand your report back to the agent that dispatched you. It receives the message as your " +
    "report, so include everything it needs: what you did, what you found, and anything left " +
    "open. You keep your turn after this call: go on working if something remains, then end your " +
    "turn. You can hand back more than once, for example a partial report and then the final " +
    "one. Once you handed back, your final reply is not delivered again. For a short note while " +
    'you work, use SendMessage with to "parent" instead.',
  inputSchema: {
    type: "object",
    properties: {
      message: {
        type: "string",
        minLength: 1,
        maxLength: 200000,
        description: "Your report for the agent that dispatched you.",
      },
    },
    required: ["message"],
    additionalProperties: false,
  },
};

/** The result of a handback (agent map spec §4.3). */
export const HANDBACK_RESULT_TEXT = "Report delivered to your caller.";

/** A call outside a sub-agent (the tool is never offered there). */
export const HANDBACK_NOT_A_CHILD_TEXT =
  "Only sub-agents can hand back a report; reply in this conversation instead.";

/**
 * The builtin. `defaultPolicy: "allow"`: it only moves text inside one tree the person already
 * started. The tool pipeline handles `SubagentHandback` calls itself; `run` answers only when a
 * call reaches it anyway.
 */
export const handbackTool: BuiltinTool = {
  spec: SPEC,
  defaultPolicy: "allow",
  run: async () => ({
    content: [{ type: "text", text: HANDBACK_NOT_A_CHILD_TEXT }],
    isError: true,
  }),
};
