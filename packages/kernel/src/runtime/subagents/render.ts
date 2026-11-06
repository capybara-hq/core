import type { EventPayload } from "../../conversations/events.js";
import { subagentStatusText } from "../../tools/builtins/agent.js";

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
 * ```
 *
 * A finish uses `agentResultText`'s status wording (`subagentStatusText`); after a handback only
 * the status itself (up to its first `;`), and without a reply `It produced no reply.` Read only
 * from the payload, so a replay renders it identically.
 */
export function renderSubagentDelivery(p: Delivery): string {
  const head = `Sub-agent ${p.subagentId} (${JSON.stringify(p.description)})`;
  switch (p.kind) {
    case "report":
      return `${head} handed back a report:\n${p.text}`;
    case "note":
      return `${head} sent a message:\n${p.text}`;
    case "finished": {
      const status = subagentStatusText(p.status ?? "completed");
      if (p.handedBack === true) {
        return `${head} ${status.split(";")[0]}; its report was already delivered.`;
      }
      return p.text.trim() === ""
        ? `${head} ${status}. It produced no reply.`
        : `${head} ${status}. Final reply:\n${p.text}`;
    }
  }
}
