"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useReducer, useState } from "react";
import { ApiClientError } from "../../lib/api";
import {
  abortRun,
  type Conversation,
  type ConversationEvent,
  getConversation,
  listAllEvents,
  type MessageInput,
  notifyConversationsChanged,
  postMessage,
} from "../../lib/conversations";
import {
  type ChatState,
  type ConversationChange,
  initialChatState,
  openConversationStream,
  reduceChat,
} from "../../lib/stream";
import { type UiRefresh, uiKey } from "../../lib/ui";
import { useErrorMessage } from "../../lib/use-error-message";

/** Consecutive reopen attempts after the browser gave up the stream (reset by any open). */
const MAX_REOPEN = 3;

/** `onSend`'s outcome: on failure the error (to mark the files it names). */
export type SendResult = { ok: true } | { ok: false; error: unknown };

export type ConversationState = {
  state: ChatState;
  events: ConversationEvent[];
  /** The conversation row (title, agent, selection); undefined while it loads. */
  conversation: Conversation | undefined;
  running: boolean;
  waiting: boolean;
  stopping: boolean;
  stop(): void;
  /** Sends (interjects while running). */
  send(m: MessageInput): Promise<SendResult>;
  /** Merges events a route returned (a queued message sent at once, …). */
  merge(events: ConversationEvent[]): void;
  error: string | undefined;
  setError(e: unknown): void;
  /** Counters bumped by `event: changed` (queue, files) and reconnects: refetch when they move. */
  changes: Readonly<Record<"queue" | "files" | "reconnect", number>>;
  /** Raises the sub-agents' calls from `GET …/subagents` (no step: never beats stream progress). */
  seedProgress(views: readonly { id: string; toolCalls: number }[]): void;
  /** Extension view refresh counters: `plugin/contribution`, `*` for all (after a reconnect). */
  uiVersions: Readonly<Record<string, number>>;
  /** Replace the conversation row (after a rename). */
  setConversation(c: Conversation): void;
};

/**
 * One conversation's live state: the history is read first, then the stream is opened from the
 * last seq; events and deltas go through {@link reduceChat}. `event: changed` refetches the row
 * (title, selection) or bumps the queue / files counters; a title change also tells the sidebar.
 * Reconnects (the browser's own, or a reopen after the browser gave up) resume from the last seq
 * the stream delivered and refetch everything outside the log.
 */
export function useConversation(orgId: string, conversationId: string): ConversationState {
  const t = useTranslations("chat");
  const errorMessage = useErrorMessage();
  const [state, dispatch] = useReducer(reduceChat, initialChatState);
  const [error, setErrorText] = useState<string>();
  const [stopping, setStopping] = useState(false);
  const [conversation, setConversation] = useState<Conversation>();
  const [changes, setChanges] = useState({ queue: 0, files: 0, reconnect: 0 });
  const [uiVersions, setUiVersions] = useState<Record<string, number>>({});
  const bumpUi = useCallback((key: string) => {
    setUiVersions((v) => ({ ...v, [key]: (v[key] ?? 0) + 1 }));
  }, []);
  const setError = useCallback((e: unknown) => setErrorText(errorMessage(e)), [errorMessage]);

  const loadConversation = useCallback(() => {
    getConversation(orgId, conversationId).then(
      ({ conversation: c }) => setConversation(c),
      () => {
        // The thread shows the stream's error; the title stays on its placeholder.
      },
    );
  }, [orgId, conversationId]);

  useEffect(() => {
    loadConversation();
  }, [loadConversation]);

  useEffect(() => {
    let disposed = false;
    let close: (() => void) | undefined;
    let failures = 0;
    /** The last seq the stream (and the history) delivered: reopen from here. */
    let streamSeq = 0;
    let connected = false;
    const fail = (e: unknown) => {
      if (!disposed) setErrorText(errorMessage(e));
    };
    const onChanged = (what: ConversationChange) => {
      if (what === "title") {
        loadConversation();
        notifyConversationsChanged();
      } else if (what === "selection") loadConversation();
      else setChanges((c) => ({ ...c, [what]: c[what] + 1 }));
    };
    const open = (after: number) => {
      close = openConversationStream(orgId, conversationId, after, {
        onOpen: () => {
          failures = 0;
          if (connected) {
            // A reconnect: frames may have been missed meanwhile.
            bumpUi("*");
            setChanges((c) => ({
              queue: c.queue + 1,
              files: c.files + 1,
              reconnect: c.reconnect + 1,
            }));
            loadConversation();
          }
          connected = true;
        },
        onUi: (r: UiRefresh) => bumpUi(uiKey(r.plugin, r.contribution)),
        onChanged,
        onEvent: (e) => {
          streamSeq = Math.max(streamSeq, e.seq);
          dispatch({ kind: "events", events: [e] });
        },
        onDelta: (d) => dispatch({ kind: "delta", delta: d }),
        onSubagentProgress: (p) => dispatch({ kind: "progress", progress: p }),
        onError: ({ code }) => {
          if (disposed) return;
          if (code !== undefined) return fail(new ApiClientError(0, code, code));
          if (++failures > MAX_REOPEN) return setErrorText(t("streamLost"));
          // Most likely the access token expired: refresh through apiFetch, then resume.
          getConversation(orgId, conversationId).then(() => {
            if (!disposed) open(streamSeq);
          }, fail);
        },
      });
    };
    listAllEvents(orgId, conversationId).then((events) => {
      if (disposed) return;
      dispatch({ kind: "events", events });
      streamSeq = events.at(-1)?.seq ?? 0;
      open(streamSeq);
    }, fail);
    return () => {
      disposed = true;
      close?.();
    };
  }, [orgId, conversationId, errorMessage, t, bumpUi, loadConversation]);

  const send = useCallback(
    async (m: MessageInput): Promise<SendResult> => {
      try {
        const { event } = await postMessage(orgId, conversationId, m);
        dispatch({ kind: "events", events: [event] });
        setErrorText(undefined);
        // A switch was logged with the message: the row's selection changed.
        if (m.model !== undefined || m.effort !== undefined) loadConversation();
        return { ok: true };
      } catch (e) {
        setErrorText(errorMessage(e));
        return { ok: false, error: e };
      }
    },
    [orgId, conversationId, errorMessage, loadConversation],
  );

  const stop = useCallback(async () => {
    setStopping(true);
    try {
      await abortRun(orgId, conversationId);
    } catch (e) {
      // The run just ended: its terminal event arrives through the stream.
      if (!(e instanceof ApiClientError && e.code === "run.not_active"))
        setErrorText(errorMessage(e));
    } finally {
      setStopping(false);
    }
  }, [orgId, conversationId, errorMessage]);

  const merge = useCallback((events: ConversationEvent[]) => {
    dispatch({ kind: "events", events });
  }, []);

  const seedProgress = useCallback((views: readonly { id: string; toolCalls: number }[]) => {
    for (const v of views) {
      dispatch({
        kind: "progress",
        progress: { subagentId: v.id, step: 0, toolCalls: v.toolCalls },
        seed: true,
      });
    }
  }, []);

  return {
    state,
    events: state.events,
    conversation: conversation?.id === conversationId ? conversation : undefined,
    running: state.running,
    waiting: state.waiting,
    stopping,
    stop: () => void stop(),
    send,
    merge,
    error,
    setError,
    changes,
    seedProgress,
    uiVersions,
    setConversation,
  };
}
