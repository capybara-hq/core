import type { EventPayload } from "../../conversations/events.js";
import { subagentStatusText } from "./status.js";

type Delivery = EventPayload<"subagent_delivery">;

/**
 * The model-visible text of a `subagent_delivery` event, rendered as a system message in the
 * parent's request (agent map spec §4.5):
 *
 * ```
 * Sub-agent <id> ("<description>") handed back a report:
 * <text>
 * Sub-agent <id> ("<description>") sent a message:
 * <text>
 * Sub-agent <id> ("<description>") completed; its report was already delivered.
 * Sub-agent <id> ("<description>") completed. Final reply:
 * <text>
 * Sub-agent <id> ("<description>") failed (<code>): <message>
 * Sub-agent <id> ("<description>") stopped by the user.
 * ```
 *
 * A finish uses `agentResultText`'s status wording (`subagentStatusText`, with the error code and
 * who stopped it); after a handback only the status itself (up to its first `;`), and without a
 * reply `It produced no reply.` A failed finish's `text` is the error message, an aborted one has
 * none. Read only from the payload, so a replay renders it identically.
 *
 * A run that handed back and then `completed` no longer gets a finished delivery (acceptance
 * 2026-11-07, `SubagentDeliveries.finishIn`); the "already delivered" line stays for the other
 * statuses after a handback and for the completed ones older logs recorded, which rebuild byte for
 * byte. The switch is the delivery's absence in the log, so it needs no `DriftReason`.
 */
export function renderSubagentDelivery(p: Delivery): string {
  const head = `Sub-agent ${p.subagentId} (${JSON.stringify(p.description)})`;
  switch (p.kind) {
    case "report":
      return `${head} handed back a report:\n${p.text}`;
    case "note":
      return `${head} sent a message:\n${p.text}`;
    case "finished": {
      const status = subagentStatusText(p.status ?? "completed", {
        errorCode: p.errorCode,
        abortedBy: p.abortedBy,
      });
      if (p.handedBack === true) {
        return `${head} ${status.split(";")[0]}; its report was already delivered.`;
      }
      const text = p.text.trim();
      if (p.status === "failed")
        return text === "" ? `${head} ${status}.` : `${head} ${status}: ${text}`;
      if (p.status === "aborted" || p.status === "timed_out") return `${head} ${status}.`;
      return text === ""
        ? `${head} ${status}. It produced no reply.`
        : `${head} ${status}. Final reply:\n${p.text}`;
    }
  }
}
