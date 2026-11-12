import type { ConversationEvent, EventPayload } from "../../conversations/events.js";

/**
 * The `plugin_context` event (memory spec §6.1): the text a `context@1` provider added to the
 * conversation at a run start, written only when it changed. Model-visible: rendered at its
 * position as a system message; after a summary that covers it, the latest non-empty one per
 * plugin follows the summary again. Its text is in the log, so it needs no `DriftReason`.
 */

/** The payload of a `plugin_context` event. */
export type PluginContextPayload = EventPayload<"plugin_context">;

/** The idempotency key of a run's `plugin_context` event for `plugin`. */
export const pluginContextIdemKey = (runId: string, plugin: string): string =>
  `plugin_context:${runId}:${plugin}`;

/** The system message of a `plugin_context` event (empty text renders nothing: ""). */
export function pluginContextText(p: PluginContextPayload): string {
  if (p.text === "") return "";
  return `<plugin-context plugin="${p.plugin}">\n${p.text}\n</plugin-context>`;
}

/** The latest `plugin_context` payload of each plugin at or before `uptoSeq`. */
export function latestPluginContexts(
  events: readonly ConversationEvent[],
  uptoSeq: number,
): Map<string, PluginContextPayload> {
  const latest = new Map<string, { seq: number; payload: PluginContextPayload }>();
  for (const e of events) {
    if (e.type !== "plugin_context" || e.seq > uptoSeq) continue;
    const prev = latest.get(e.payload.plugin);
    if (!prev || e.seq > prev.seq) latest.set(e.payload.plugin, { seq: e.seq, payload: e.payload });
  }
  return new Map([...latest].map(([plugin, v]) => [plugin, v.payload]));
}

/**
 * The system messages that follow a summary covering up to `after`: the latest non-empty
 * `plugin_context` of each plugin, in plugin-name order.
 */
export function pluginContextsAfterSummary(
  events: readonly ConversationEvent[],
  after: number,
): string[] {
  return [...latestPluginContexts(events, after)]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, p]) => pluginContextText(p))
    .filter((text) => text !== "");
}
