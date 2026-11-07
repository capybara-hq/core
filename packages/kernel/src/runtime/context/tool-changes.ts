import type { ConversationEvent, EventPayload } from "../../conversations/events.js";
import { TOOLS_UNSUPPORTED_REMINDER } from "./reminders.js";

/**
 * Tool set changes mid-conversation (tool naming spec §9.1). The kernel resolves the tools on every
 * step, so an extension switched on in the org, a connector set up or a sub-agent roster added
 * changes the next request's tool list; earlier answers in the history ("I have no web search")
 * would still contradict it. A step whose resolved set differs from the one the previous request
 * offered logs a `tools_changed` event before its request; request building renders it at its
 * position as a system message ({@link toolsChangedText}).
 */

export type ToolsChange = Pick<EventPayload<"tools_changed">, "added" | "removed">;

/**
 * The tool set the conversation's previous model request offered, from the log alone: the last
 * `model_call`'s `tools` and `catalog` keys (with `ToolSearch` the catalog holds the deferred
 * tools, so the union is the whole resolved set), then any `tools_changed` logged after it (a
 * step that logged its change and crashed before its request: the change is not logged twice).
 * Skipped: a `model_call` without recorded tools (older logs) and a call whose tools were left out
 * because its model has no tool support (empty, with that step's unsupported reminder): those say
 * nothing about the resolved set. Null when no request offered a known set yet.
 */
export function previousToolSet(events: readonly ConversationEvent[]): Set<string> | null {
  const unsupported = new Set<string>();
  for (const e of events) {
    if (e.type === "reminder" && e.payload.text === TOOLS_UNSUPPORTED_REMINDER) {
      unsupported.add(`${e.runId ?? ""}\u0000${e.payload.step}`);
    }
  }
  let known: Set<string> | null = null;
  for (const e of events) {
    if (e.type === "model_call") {
      const { tools, catalog } = e.payload.request;
      if (tools === undefined) continue;
      const keys = [...tools, ...(catalog ?? [])].map((t) => t.key);
      if (keys.length === 0 && unsupported.has(`${e.runId ?? ""}\u0000${e.payload.step}`)) continue;
      known = new Set(keys);
    } else if (e.type === "tools_changed" && known !== null) {
      for (const k of e.payload.removed) known.delete(k);
      for (const k of e.payload.added) known.add(k);
    }
  }
  return known;
}

/**
 * The change from the previous request's tool set to `current` (sorted names), or null: before
 * the conversation's first request (its list is the baseline) and when nothing changed.
 */
export function toolSetChange(
  events: readonly ConversationEvent[],
  current: readonly string[],
): ToolsChange | null {
  const before = previousToolSet(events);
  if (before === null) return null;
  const now = new Set(current);
  const added = [...now].filter((k) => !before.has(k)).sort();
  const removed = [...before].filter((k) => !now.has(k)).sort();
  return added.length === 0 && removed.length === 0 ? null : { added, removed };
}

/** The model-visible text of a `tools_changed` event (English). */
export function toolsChangedText(change: ToolsChange): string {
  const parts = ["Your tools changed."];
  if (change.added.length > 0) parts.push(`Now available: ${change.added.join(", ")}.`);
  if (change.removed.length > 0) parts.push(`No longer available: ${change.removed.join(", ")}.`);
  parts.push(
    "Use the current tool list; it replaces anything said earlier in this conversation about which tools you have.",
  );
  return parts.join(" ");
}
