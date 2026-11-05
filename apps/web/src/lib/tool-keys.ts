import type { ConversationEvent } from "./conversations";

/**
 * The tool keys the timeline names (for `GET …/tools?keys=`), a sub-agent's waits' included. Its
 * own module (no UI imports): the conversation page's server snapshot asks for the same keys.
 */
export function toolKeysOf(events: readonly ConversationEvent[]): string[] {
  const keys = new Set<string>();
  for (const e of events) {
    if (e.type === "subagent_waiting") keys.add(e.payload.toolKey);
    if (e.type !== "assistant_message") continue;
    for (const b of e.payload.content) if (b.type === "tool_call") keys.add(b.name);
  }
  return [...keys];
}
