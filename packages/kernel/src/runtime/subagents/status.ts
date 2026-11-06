import type { EventPayload } from "../../conversations/events.js";

/** How a sub-agent's run ended (`subagent_finished.status`, a finished `subagent_delivery`). */
export type SubagentStatus = EventPayload<"subagent_finished">["status"];

/** Who stopped an aborted sub-agent: a person, or the kernel on its parent run's behalf. */
export type SubagentAbortedBy = "user" | "parent";

/**
 * How a sub-agent's run ended, as the model reads it: the status of `agentResultText`'s bracket
 * line (a fork invocation's report) and of a finished `subagent_delivery`
 * (`renderSubagentDelivery`).
 */
export function subagentStatusText(
  status: SubagentStatus,
  opts: { errorCode?: string | undefined; abortedBy?: SubagentAbortedBy | undefined } = {},
): string {
  switch (status) {
    case "completed":
      return "completed";
    case "max_steps":
      return "stopped at the step limit; the reply may be partial";
    case "max_duration":
      return "stopped at the time limit; the reply may be partial";
    case "budget":
      return "stopped: token budget used up";
    case "aborted":
      return opts.abortedBy === "parent" ? "stopped with this run" : "stopped by the user";
    case "timed_out":
      return "timed out";
    case "failed":
      return opts.errorCode === undefined ? "failed" : `failed (${opts.errorCode})`;
  }
}
