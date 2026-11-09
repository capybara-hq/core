// Client events (client extensions spec §7.5): derived on the client from the conversation event
// log the page already reads. Nothing here is model-visible and nothing is sent to the kernel.
import { useEffect, useRef } from "react";
import type { ConversationEvent } from "../../lib/conversations";

/** The payload shapes of `@capybara-hq/plugin-client`'s `CapybaraEvent` (spec §7.5, API version 1). */
interface EventBase {
  conversationId: string;
  seq: number;
  /** ISO time of the event. */
  at: string;
}
export type CapybaraEvent =
  | ({ type: "run.started" } & EventBase)
  | ({ type: "run.finished"; reason: string } & EventBase)
  | ({ type: "run.failed"; code: string } & EventBase)
  | ({ type: "message.sent" } & EventBase)
  | ({ type: "message.received" } & EventBase)
  | ({ type: "tool.started"; callId: string; tool: string } & EventBase)
  | ({ type: "tool.finished"; callId: string; tool: string; isError: boolean } & EventBase)
  | ({ type: "approval.requested"; callId: string } & EventBase);

/** The client event a log event stands for (the table of spec §7.5); null: it emits nothing. */
export function clientEventOf(e: ConversationEvent): CapybaraEvent | null {
  const base = { conversationId: e.conversationId, seq: e.seq, at: e.createdAt };
  switch (e.type) {
    case "run_started":
      return { type: "run.started", ...base };
    case "run_finished":
      return { type: "run.finished", reason: e.payload.reason, ...base };
    case "run_aborted":
      return { type: "run.finished", reason: "aborted", ...base };
    case "run_failed":
      return { type: "run.failed", code: e.payload.error.code, ...base };
    case "user_message":
      // A parent agent's dispatch or SendMessage is not a person's message.
      return e.payload.dispatch === undefined ? { type: "message.sent", ...base } : null;
    case "assistant_message":
      return { type: "message.received", ...base };
    case "tool_call_started":
      return {
        type: "tool.started",
        callId: e.payload.callId,
        tool: e.payload.toolKey,
        ...base,
      };
    case "tool_result":
      return {
        type: "tool.finished",
        callId: e.payload.callId,
        tool: e.payload.toolKey,
        isError: e.payload.isError,
        ...base,
      };
    case "approval_requested":
      return { type: "approval.requested", callId: e.payload.callId, ...base };
    default:
      return null;
  }
}

/**
 * Follows one conversation's log. The first list it sees is the history loaded on open: its
 * highest seq is the baseline and it emits nothing. Every later list emits each event above the
 * baseline once, in the list's order (a stream catch-up after a reconnect lands here too). An
 * event with a lower seq arriving after a higher one (a send's own event can reach the cache
 * before the stream delivers the ones before it) still emits, once: the feed keeps the seqs it has
 * seen above the baseline, not a high-water mark. Events at or below the baseline (an earlier page
 * of history) never emit.
 */
export function createEventFeed(emit: (e: CapybaraEvent) => void) {
  let baseline: number | null = null;
  const seen = new Set<number>();
  return {
    observe(events: readonly ConversationEvent[]): void {
      if (baseline === null) {
        baseline = events.reduce((m, e) => Math.max(m, e.seq), 0);
        return;
      }
      for (const e of events) {
        if (e.seq <= baseline || seen.has(e.seq)) continue;
        seen.add(e.seq);
        const out = clientEventOf(e);
        if (out !== null) emit(out);
      }
    },
  };
}

/** A listener of client events; `onError` is told when it throws (the crash budget, spec §10.3). */
interface Subscription {
  listener: (e: CapybaraEvent) => void;
  onError?: (error: unknown) => void;
}

// Browser-only state of this tab: the listeners of the client extensions loaded in it.
const subscriptions = new Set<Subscription>();

/** Subscribes to every client event; returns the unsubscribe function. */
export function subscribeClientEvents(
  listener: (e: CapybaraEvent) => void,
  onError?: (error: unknown) => void,
): () => void {
  const s: Subscription = { listener, ...(onError === undefined ? {} : { onError }) };
  subscriptions.add(s);
  return () => {
    subscriptions.delete(s);
  };
}

/**
 * Delivers `e` to the listeners asynchronously (a microtask after the update that carried it
 * commits). A listener that throws does not stop the next one.
 */
export function emitClientEvent(e: CapybaraEvent): void {
  queueMicrotask(() => {
    for (const s of [...subscriptions]) {
      try {
        s.listener(e);
      } catch (error) {
        try {
          s.onError?.(error);
        } catch {
          // a failing error handler must not stop the next listener either
        }
      }
    }
  });
}

/**
 * Feeds the open conversation's log to the client events: the history the page opened with is the
 * baseline, what is appended while it is open is delivered. A different conversation starts a new
 * feed. `loaded` is false while the log is still on its way.
 */
export function useClientEventFeed(
  conversationId: string,
  events: readonly ConversationEvent[],
  loaded: boolean,
): void {
  const feed = useRef<{ id: string; feed: ReturnType<typeof createEventFeed> } | null>(null);
  useEffect(() => {
    if (!loaded) return;
    if (feed.current?.id !== conversationId)
      feed.current = { id: conversationId, feed: createEventFeed(emitClientEvent) };
    feed.current.feed.observe(events);
  }, [conversationId, events, loaded]);
}
