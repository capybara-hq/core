"use client";

import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useRouter } from "../../i18n/navigation";
import { ApiClientError } from "../../lib/api";
import {
  abortRun,
  type Conversation,
  type ConversationEvent,
  type MessageInput,
  postMessage,
} from "../../lib/conversations";
import { retryOnMountOf } from "../../lib/query/client";
import {
  appendEvents,
  CONVERSATION_SIDE_KEYS,
  conversationQuery,
  eventsQuery,
  isFreshlySeeded,
} from "../../lib/query/conversation";
import { keys } from "../../lib/query/keys";
import { useAppMutation } from "../../lib/query/mutation";
import { refreshUiViews } from "../../lib/query/ui";
import {
  type ChatState,
  type ConversationChange,
  initialChatState,
  openConversationStream,
  reduceChat,
  type StreamDelta,
  type SubagentProgress,
} from "../../lib/stream";
import { useErrorMessage } from "../../lib/use-error-message";

/** Consecutive reopen attempts after the browser gave up the stream (reset by any open). */
const MAX_REOPEN = 3;

const frame = (cb: () => void): number =>
  typeof requestAnimationFrame === "function"
    ? requestAnimationFrame(cb)
    : (setTimeout(cb, 16) as unknown as number);
const cancelFrame = (id: number): void => {
  if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(id);
  else clearTimeout(id);
};

/**
 * The last seq each conversation's stream delivered (`org/id`), per query client, written by the
 * stream's effects in the browser only. The cached log may hold a later event a send returned
 * before the stream delivered the ones before it, so a stream resumes after the lower of this and
 * the log's end.
 */
const deliveredBy = new WeakMap<QueryClient, Map<string, number>>();

/**
 * The resume points of `qc`'s conversations. A log read whole (a fetch, not a write of the
 * stream's) is complete up to its end: its conversation's point is dropped, so the next open
 * resumes at that end instead of replaying what the read already holds.
 */
function deliveredOf(qc: QueryClient): Map<string, number> {
  const known = deliveredBy.get(qc);
  if (known !== undefined) return known;
  const map = new Map<string, number>();
  deliveredBy.set(qc, map);
  qc.getQueryCache().subscribe((event) => {
    if (event.type !== "updated" || event.action.type !== "success" || event.action.manual) return;
    const k = event.query.queryKey;
    if (k[0] === "org" && k[2] === "conversation" && k[4] === "events")
      map.delete(`${String(k[1])}/${String(k[3])}`);
  });
  return map;
}

/** `onSend`'s outcome: on failure the error (to mark the files it names). */
export type SendResult = { ok: true } | { ok: false; error: unknown };

export type ConversationState = {
  state: ChatState;
  events: ConversationEvent[];
  /** The log is still on its way (nothing cached): the thread shows its loading state. */
  loading: boolean;
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
  /** Raises the sub-agents' calls from `GET …/subagents` (no step: never beats stream progress). */
  seedProgress(views: readonly { id: string; toolCalls: number }[]): void;
  /** Replace the conversation row (after a rename). */
  setConversation(c: Conversation): void;
};

/** The progress inputs of {@link reduceChat}, kept apart from the log (they are not events). */
const reduceProgress = (
  progress: ChatState["progress"],
  input: { progress: SubagentProgress; seed?: boolean },
): ChatState["progress"] =>
  reduceChat({ ...initialChatState, progress }, { kind: "progress", ...input }).progress;

/**
 * One conversation's live state (web query cache spec §6): the log is the cached `eventsQuery`
 * (the layout's prefetch, else read here), and the stream, opened from its last seq, appends each
 * event to it through {@link appendEvents}. {@link reduceChat} turns the cached list plus the
 * frame's delta buffer into the thread's state; deltas and sub-agent progress are not events and
 * stay here.
 *
 * `event: changed` invalidates the matching query (the row, the queue, the files) instead of
 * reading it here; a title change and the run's phase also invalidate the sidebar's groups. When
 * an open's catch-up delivers events, what lives outside the log (`CONVERSATION_SIDE_KEYS`) is
 * invalidated; without one it follows its freshness class. Reconnects (the browser's own, or a
 * reopen after the browser gave up) resume from the last seq the cache holds.
 */
export function useConversation(orgId: string, conversationId: string): ConversationState {
  const t = useTranslations("chat");
  const router = useRouter();
  const qc = useQueryClient();
  const errorMessage = useErrorMessage();
  const eventsQ = eventsQuery(orgId, conversationId);
  const rowQ = conversationQuery(orgId, conversationId);
  const log = useQuery({ ...eventsQ, retryOnMount: retryOnMountOf(eventsQ.queryKey) });
  const row = useQuery({ ...rowQ, retryOnMount: retryOnMountOf(rowQ.queryKey) });
  const events = log.data;
  /** The deltas since the log last changed in a way that drops them (applied per frame). */
  const [deltas, setDeltas] = useState<readonly StreamDelta[]>([]);
  const [progress, dispatchProgress] = useReducer(reduceProgress, {});
  // The log's state is rebuilt when the cached list changes; a delta frame only adds drafts (I3).
  const base = useMemo(
    () =>
      events === undefined
        ? initialChatState
        : reduceChat(initialChatState, { kind: "events", events }),
    [events],
  );
  const drafted = useMemo(
    () => (deltas.length === 0 ? base : reduceChat(base, { kind: "deltas", deltas })),
    [base, deltas],
  );
  // Deltas of a step its message replaced, or of a run that ended, are ignored for good: drop them.
  useEffect(() => {
    setDeltas((d) => {
      const kept = d.filter(
        (x) => !base.finalized[`${x.runId}:${x.step}`] && !base.closedRuns[x.runId],
      );
      return kept.length === d.length ? d : kept;
    });
  }, [base]);
  const state = useMemo(() => ({ ...drafted, progress }), [drafted, progress]);

  const [error, setErrorText] = useState<string>();
  const [stopping, setStopping] = useState(false);
  const setError = useCallback((e: unknown) => setErrorText(errorMessage(e)), [errorMessage]);
  const loaded = events !== undefined;
  /**
   * The current open has not delivered a new event yet: the first one ends its catch-up. A
   * person's own write (a send, a queued send) ends it too: what follows answers it, live.
   */
  const catchingUp = useRef(true);

  useEffect(() => {
    if (!loaded) return;
    const c = keys.org(orgId).conversation(conversationId);
    const invalidate = (queryKey: readonly unknown[]) => void qc.invalidateQueries({ queryKey });
    const groups = keys.org(orgId).conversationGroupsAll();
    let disposed = false;
    let close: (() => void) | undefined;
    let failures = 0;
    /** The row was read again once for a title generated before the stream was open. */
    // A conversation seeded from the create answer changed nothing outside the log since (send
    // spec 2.1): its first open is no catch-up and reads no side key. Only the first: a later
    // reconnect catches up as usual. Its title is still checked below: a quick run's title is
    // often generated before the stream opens.
    let seeded = isFreshlySeeded(qc, orgId, conversationId);
    let titleChecked = false;
    // Deltas are applied once per animation frame, together (final review I3): a fast stream
    // renders the page per frame, not per token. An event first flushes what is pending, so
    // deltas and events stay in stream order.
    let pending: StreamDelta[] = [];
    let scheduled: number | null = null;
    const flush = () => {
      if (scheduled !== null) cancelFrame(scheduled);
      scheduled = null;
      if (pending.length === 0) return;
      const frameDeltas = pending;
      pending = [];
      setDeltas((d) => [...d, ...frameDeltas]);
    };
    const fail = (e: unknown) => {
      if (!disposed) setErrorText(errorMessage(e));
    };
    const onChanged = (what: ConversationChange) => {
      // Archived or deleted elsewhere (another tab, the CLI): the sidebar's lists change; a deleted
      // conversation is gone, so the page goes to a new one (an archived one stays open).
      if (what === "archived" || what === "deleted") {
        invalidate(groups);
        if (what === "deleted") router.push("/chat");
        return;
      }
      if (what === "selection") invalidate(c.row());
      // A new title shows in the sidebar too; a title this page already shows (the person's own
      // rename, whose mutation reads the groups itself) reads them no second time.
      if (what === "title") {
        const before = qc.getQueryData<Conversation>(c.row())?.title;
        void qc.refetchQueries({ queryKey: c.row(), exact: true }).then(() => {
          if (!disposed && qc.getQueryData<Conversation>(c.row())?.title !== before) {
            invalidate(groups);
          }
        });
      }
      if (what === "queue") invalidate(c.queue());
      if (what === "files") invalidate(c.files());
      // A task started or finished (also a sub-agent's): the list and the open outputs.
      if (what === "background") invalidate(c.background());
    };
    const scope = `${orgId}/${conversationId}`;
    const delivered = deliveredOf(qc);
    /** Where an open resumes: after what the stream delivered, never past the cached log's end. */
    const resumeAt = () => {
      const end = qc.getQueryData<ConversationEvent[]>(c.events())?.at(-1)?.seq ?? 0;
      return Math.min(delivered.get(scope) ?? end, end);
    };
    // A log read in full is complete up to its end (the layout's or this page's first read).
    if (!delivered.has(scope)) delivered.set(scope, resumeAt());
    const open = () => {
      catchingUp.current = !seeded;
      close = openConversationStream(orgId, conversationId, resumeAt(), {
        onOpen: () => {
          failures = 0;
          // The browser's own reconnect: its catch-up follows the same rule.
          catchingUp.current = !seeded;
          seeded = false;
          // An untitled conversation's title may have been generated before the stream was open
          // (its `changed: title` reached nobody): read the row once. A named one reads nothing.
          const row = qc.getQueryData<Conversation>(c.row());
          if (!titleChecked && row !== undefined && row.title === null) {
            titleChecked = true;
            // A title found that way shows in the sidebar too (its groups missed the frame).
            void qc.refetchQueries({ queryKey: c.row(), exact: true }).then(() => {
              if (!disposed && qc.getQueryData<Conversation>(c.row())?.title != null) {
                invalidate(groups);
              }
            });
          }
        },
        // An extension view changed: read again, coalesced (at most one read in flight).
        onUi: (r) =>
          refreshUiViews(qc, keys.org(orgId).uiViews(conversationId, r.plugin, r.contribution)),
        onChanged,
        onEvent: (e) => {
          flush();
          delivered.set(scope, Math.max(delivered.get(scope) ?? 0, e.seq));
          const { added } = appendEvents(qc, orgId, conversationId, [e]);
          // The catch-up delivered something: what lives outside the log may have changed too.
          if (catchingUp.current && added > 0) {
            catchingUp.current = false;
            for (const k of CONVERSATION_SIDE_KEYS(orgId, conversationId)) invalidate(k);
          }
        },
        onDelta: (d) => {
          pending.push(d);
          scheduled ??= frame(flush);
        },
        onSubagentProgress: (p) => dispatchProgress({ progress: p }),
        onError: ({ code }) => {
          if (disposed) return;
          if (code !== undefined) return fail(new ApiClientError(0, code, code));
          if (++failures > MAX_REOPEN) return setErrorText(t("streamLost"));
          // Most likely the access token expired: refresh through apiFetch, then resume.
          qc.fetchQuery({ ...conversationQuery(orgId, conversationId), staleTime: 0 }).then(() => {
            if (!disposed) open();
          }, fail);
        },
      });
    };
    open();
    return () => {
      disposed = true;
      if (scheduled !== null) cancelFrame(scheduled);
      close?.();
    };
  }, [orgId, conversationId, loaded, qc, errorMessage, t, router]);

  const sendMutation = useAppMutation({
    fn: async (m: MessageInput) => {
      const { event } = await postMessage(orgId, conversationId, m);
      catchingUp.current = false;
      appendEvents(qc, orgId, conversationId, [event]);
      return event;
    },
    // A switch was logged with the message: the row's selection changed.
    invalidates: (m) =>
      m.model !== undefined || m.effort !== undefined
        ? [keys.org(orgId).conversation(conversationId).row()]
        : [],
  });
  const send = useCallback(
    async (m: MessageInput): Promise<SendResult> => {
      try {
        await sendMutation.mutateAsync(m);
        setErrorText(undefined);
        return { ok: true };
      } catch (e) {
        setErrorText(errorMessage(e));
        return { ok: false, error: e };
      }
    },
    [sendMutation.mutateAsync, errorMessage],
  );

  // The run's terminal event arrives through the stream: nothing to invalidate.
  const abort = useAppMutation({
    fn: () => abortRun(orgId, conversationId),
    invalidates: () => [],
  });
  const stop = useCallback(async () => {
    setStopping(true);
    try {
      await abort.mutateAsync(undefined);
    } catch (e) {
      // The run just ended: its terminal event arrives through the stream.
      if (!(e instanceof ApiClientError && e.code === "run.not_active"))
        setErrorText(errorMessage(e));
    } finally {
      setStopping(false);
    }
  }, [abort.mutateAsync, errorMessage]);

  // A row the caller got from a write (a rename) is the new state: it replaces the cached one.
  const replaceConversation = useCallback(
    (c: Conversation) => {
      void qc.cancelQueries({ queryKey: rowQ.queryKey });
      qc.setQueryData(rowQ.queryKey, c);
    },
    [qc, rowQ.queryKey],
  );

  const merge = useCallback(
    (list: ConversationEvent[]) => {
      catchingUp.current = false;
      appendEvents(qc, orgId, conversationId, list);
    },
    [qc, orgId, conversationId],
  );

  const seedProgress = useCallback((views: readonly { id: string; toolCalls: number }[]) => {
    for (const v of views)
      dispatchProgress({
        progress: { subagentId: v.id, step: 0, toolCalls: v.toolCalls },
        seed: true,
      });
  }, []);

  // The open conversation's run started, began or stopped waiting, or ended: the sidebar's state
  // dot for it changes. The first phase read (the history) is the baseline, not a change.
  const phase = !loaded ? null : state.waiting ? "waiting" : state.running ? "running" : "idle";
  const lastPhase = useRef<{ id: string; phase: string } | null>(null);
  useEffect(() => {
    if (phase === null) return;
    const last = lastPhase.current;
    lastPhase.current = { id: conversationId, phase };
    if (last !== null && last.id === conversationId && last.phase !== phase)
      void qc.invalidateQueries({ queryKey: keys.org(orgId).conversationGroupsAll() });
  }, [qc, orgId, conversationId, phase]);

  const logError = log.error === null ? undefined : errorMessage(log.error);
  return {
    state,
    events: state.events,
    loading: !loaded && log.error === null,
    conversation: row.data,
    running: state.running,
    waiting: state.waiting,
    stopping,
    stop: () => void stop(),
    send,
    merge,
    error: error ?? logError,
    setError,
    seedProgress,
    setConversation: replaceConversation,
  };
}
