import { type ConversationEvent, streamUrl } from "./conversations";
import { LiveDrafts } from "./live-drafts";
import { PersonWaits } from "./person-waits";
import { fetchRunDrafts, type RunDraftSnapshot } from "./run-drafts";
import { parseUiRefresh, type UiRefresh } from "./ui";

/**
 * A streaming update of one step's draft (only a draft: the step's `assistant_message` in the log
 * is the final content).
 *
 * - `text` / `thinking`: the SSE `event: delta` frame, `text` appended to that channel; `offset` is
 *   the characters of that channel before it (per channel, from 0 at each step and `step_reset`).
 * - `step_reset`: the step starts over (its draft is dropped).
 * - `draft`: a step's draft so far, for each channel given (`text`, `thinking`; one left out is
 *   kept). With `replace` it sets those channels (a channel starting over at offset 0); with
 *   `resync` (an `event: draft` frame) a channel that is a prefix of what is shown keeps the longer
 *   (the stored draft can lag the screen) and any other replaces it (a reset, a new attempt);
 *   with neither, the longer wins (a draft read after a gap never shrinks what is shown). Produced by the stream opener's live drafts
 *   (`lib/live-drafts.ts`, spec 2026-11-07-run-input-and-live-drafts §4).
 */
export interface StreamDelta {
  runId: string;
  step: number;
  delta: "text" | "thinking" | "step_reset" | "draft";
  text?: string;
  /** `draft` only: the step's thinking so far. */
  thinking?: string;
  offset?: number;
  /** `draft` only: set the channels given instead of keeping the longer. */
  replace?: boolean;
  /** `draft` only: keep what is shown where the channel given is a prefix of it, else set it. */
  resync?: boolean;
}

/** What `event: changed` names (kernel `CONVERSATION_CHANGES`). */
export type ConversationChange =
  | "title"
  | "queue"
  | "selection"
  | "files"
  | "archived"
  | "deleted"
  | "background";
const CHANGES = new Set<string>([
  "title",
  "queue",
  "selection",
  "files",
  "archived",
  "deleted",
  "background",
]);

/**
 * SSE `event: subagent_progress` on a parent's stream: a sub-agent finished a step (ephemeral, not
 * in the log; a reconnecting client reads the numbers from `GET .../subagents`).
 */
export interface SubagentProgress {
  subagentId: string;
  step: number;
  toolCalls: number;
  lastToolKey?: string;
}

/**
 * SSE `event: compaction` (context compaction spec §4.6): a run of this conversation is compacting.
 * Ephemeral and display-only, never in the log; the `compaction_summary` / `compaction_failed`
 * event ends the row. `chunk` / `chunks` are set only in the chunked path (a real `i/N`); a
 * single-call compaction never shows a percentage.
 */
export interface CompactionProgress {
  runId: string;
  conversationId: string;
  agentId?: string;
  phase: "preparing" | "summarizing" | "writing";
  step: number;
  chunk?: number;
  chunks?: number;
  chars?: number;
  startedAt: number;
}

/**
 * The compaction progress after a frame: within one run an older frame never replaces a newer one
 * (the ordering guard); a frame of another run replaces what is shown — frames of different runs
 * are separate compactions, and a new run owns the row.
 */
export function acceptCompaction(
  current: CompactionProgress | null,
  next: CompactionProgress,
): CompactionProgress | null {
  if (current !== null && current.runId === next.runId && next.startedAt < current.startedAt) {
    return current;
  }
  return next;
}

export interface StreamHandlers {
  onEvent(e: ConversationEvent): void;
  /**
   * The drafts' updates, in stream order and without gaps or repeats: a delta the draft already
   * holds is dropped, one that overlaps it is trimmed to what is new, and the deltas past a gap
   * are held until a draft read covers them (then one `draft` replaces the step's draft).
   */
  onDelta(d: StreamDelta): void;
  /** `event: subagent_progress`: one of this conversation's sub-agents made progress. */
  onSubagentProgress?(p: SubagentProgress): void;
  /** `event: compaction`: a run of this conversation is compacting (ephemeral). */
  onCompaction?(p: CompactionProgress): void;
  /** `event: ui`：插件的某个对话视图变了（去重新取）。 */
  onUi?(r: UiRefresh): void;
  /** `event: changed`: a part of the conversation outside the log changed (title, queue, …). */
  onChanged?(what: ConversationChange): void;
  /** 连接（含浏览器自动重连）已建立。 */
  onOpen?(): void;
  /**
   * 流已终止、不会再自动重连：`code` 为服务端 `event: error` 帧的错误码（如会话被吊销）；
   * 没有 `code` 表示连接被浏览器放弃（例如重连时得到非 200 响应）。
   */
  onError?(e: { code?: string }): void;
}

const CLOSED = 2;

/**
 * 打开会话事件流（`GET .../conversations/:id/stream?after=<seq>`，经同源代理）。
 * 断线时浏览器自动重连并带上 `Last-Event-ID`（内核优先于 `after` 使用它）；
 * 服务端发 `event: error` 帧后立即关闭，不再重连。返回关闭函数。
 * Live drafts (`event: draft`, delta offsets) go through {@link LiveDrafts}: a reconnect resumes a
 * streaming reply without a gap or a repeat.
 */
export function openConversationStream(
  orgId: string,
  conversationId: string,
  afterSeq: number,
  handlers: StreamHandlers,
): () => void {
  const es = new EventSource(streamUrl(orgId, conversationId, afterSeq));
  let closed = false;
  const live = new LiveDrafts(
    (d) => {
      if (!closed) handlers.onDelta(d);
    },
    (runId) => fetchRunDrafts(orgId, conversationId, runId),
  );
  const close = () => {
    closed = true;
    live.close();
    es.close();
  };
  const parse = (e: Event): unknown => {
    if (!(e instanceof MessageEvent) || typeof e.data !== "string") return undefined;
    try {
      return JSON.parse(e.data);
    } catch {
      return undefined;
    }
  };
  es.addEventListener("open", () => {
    if (closed) return;
    live.reset();
    handlers.onOpen?.();
  });
  es.addEventListener("event", (e) => {
    const data = parse(e);
    if (closed || data === undefined) return;
    live.event(data as ConversationEvent);
    handlers.onEvent(data as ConversationEvent);
  });
  es.addEventListener("draft", (e) => {
    const d = parse(e) as Partial<RunDraftSnapshot & { runId: string }> | undefined;
    if (closed || typeof d?.runId !== "string" || typeof d.step !== "number") return;
    live.draft({
      runId: d.runId,
      step: d.step,
      text: typeof d.text === "string" ? d.text : "",
      thinking: typeof d.thinking === "string" ? d.thinking : "",
    });
  });
  es.addEventListener("delta", (e) => {
    const data = parse(e);
    if (!closed && data !== undefined) live.delta(data as StreamDelta);
  });
  es.addEventListener("changed", (e) => {
    const what = (parse(e) as { what?: unknown } | undefined)?.what;
    if (!closed && typeof what === "string" && CHANGES.has(what))
      handlers.onChanged?.(what as ConversationChange);
  });
  es.addEventListener("subagent_progress", (e) => {
    const data = parse(e) as Partial<SubagentProgress> | undefined;
    if (closed || typeof data?.subagentId !== "string" || typeof data.toolCalls !== "number")
      return;
    handlers.onSubagentProgress?.(data as SubagentProgress);
  });
  es.addEventListener("compaction", (e) => {
    const data = parse(e) as Partial<CompactionProgress> | undefined;
    // a child's compaction is published only on the child's own stream: a frame naming another
    // conversation never draws a row here (the root does not render another agent's compaction)
    if (
      closed ||
      typeof data?.runId !== "string" ||
      data.conversationId !== conversationId ||
      typeof data.step !== "number" ||
      typeof data.startedAt !== "number"
    )
      return;
    handlers.onCompaction?.(data as CompactionProgress);
  });
  es.addEventListener("ui", (e) => {
    const r = parseUiRefresh(parse(e));
    if (!closed && r !== undefined) handlers.onUi?.(r);
  });
  // 「error」既是服务端错误帧的事件名（MessageEvent，带 data），也是 EventSource 自身的连接错误（普通 Event）。
  es.addEventListener("error", (e) => {
    if (closed) return;
    const data = parse(e) as { code?: unknown } | undefined;
    if (data !== undefined) {
      close();
      handlers.onError?.(typeof data.code === "string" ? { code: data.code } : {});
      return;
    }
    // 仍在 CONNECTING：浏览器会自动重连，不打扰调用方
    if (es.readyState === CLOSED) {
      close();
      handlers.onError?.({});
    }
  });
  return close;
}

// ---------------------------------------------------------------------------
// 会话状态归约
// ---------------------------------------------------------------------------

export interface Draft {
  runId: string;
  step: number;
  text: string;
  thinking: string;
}

export interface ChatState {
  /** 已收到的事件，按 seq 升序、不重复。 */
  events: ConversationEvent[];
  /** 已收到的最大 seq（重新订阅时作为 `after`）。 */
  lastSeq: number;
  /** 流式草稿，按首个增量到达的顺序。 */
  drafts: Draft[];
  /** 已有 assistant_message 的 `${runId}:${step}`：之后到达的增量一律忽略。 */
  finalized: Readonly<Record<string, true>>;
  /** 已到终态（finished / failed / aborted）的运行：之后到达的增量一律忽略。 */
  closedRuns: Readonly<Record<string, true>>;
  /** `run_started` 之后、终态事件之前，且不在等人处理。 */
  running: boolean;
  /** 运行在等人处理审批或输入请求（不是终态，也不算运行中）。 */
  waiting: boolean;
  /** The latest progress of each sub-agent (ephemeral stream messages), by sub-agent id. */
  progress: Readonly<Record<string, SubagentProgress>>;
}

export type ChatInput =
  | { kind: "events"; events: ConversationEvent[] }
  | { kind: "delta"; delta: StreamDelta }
  /** The deltas of one animation frame, applied in order (one render per frame, I3). */
  | { kind: "deltas"; deltas: readonly StreamDelta[] }
  | {
      kind: "progress";
      progress: SubagentProgress;
      /**
       * A seed from `GET /subagents` (after loading or reconnecting): it has no step, so it only
       * raises the calls of what is already known instead of competing with stream steps.
       */
      seed?: boolean;
    };

export const initialChatState: ChatState = {
  events: [],
  lastSeq: 0,
  drafts: [],
  finalized: {},
  closedRuns: {},
  running: false,
  waiting: false,
  progress: {},
};

const TERMINAL = new Set<ConversationEvent["type"]>(["run_finished", "run_failed", "run_aborted"]);

const stepKey = (runId: string, step: number) => `${runId}:${step}`;

/** 二分查找 seq 的插入位置；`found` 表示已存在。 */
function locate(events: ConversationEvent[], seq: number): { at: number; found: boolean } {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const s = (events[mid] as ConversationEvent).seq;
    if (s === seq) return { at: mid, found: true };
    if (s < seq) lo = mid + 1;
    else hi = mid;
  }
  return { at: lo, found: false };
}

/** The run in progress and whether it waits for a person (`waiting` is not terminal: it goes on). */
function runPhase(events: ConversationEvent[]): { running: boolean; waiting: boolean } {
  let active: string | null = null;
  const waits = new PersonWaits();
  for (const e of events) {
    if (e.type === "run_started") {
      active = e.runId;
      waits.clear();
    } else if (e.runId === null || e.runId !== active) {
    } else if (TERMINAL.has(e.type)) {
      active = null;
      waits.clear();
    } else {
      waits.apply(e);
    }
  }
  return {
    running: active !== null && !waits.waiting,
    waiting: active !== null && waits.waiting,
  };
}

function mergeEvents(state: ChatState, incoming: ConversationEvent[]): ChatState {
  let events: ConversationEvent[] | undefined;
  const finalized: Record<string, true> = { ...state.finalized };
  const closedRuns: Record<string, true> = { ...state.closedRuns };
  for (const e of incoming) {
    const list = events ?? state.events;
    const { at, found } = locate(list, e.seq);
    if (found) continue;
    events ??= [...state.events];
    events.splice(at, 0, e);
    if (e.type === "assistant_message" && e.runId !== null) {
      finalized[stepKey(e.runId, e.payload.step)] = true;
    } else if (TERMINAL.has(e.type) && e.runId !== null) {
      closedRuns[e.runId] = true;
    }
  }
  if (events === undefined) return state;
  const drafts = state.drafts.filter(
    (d) => !finalized[stepKey(d.runId, d.step)] && !closedRuns[d.runId],
  );
  return {
    events,
    lastSeq: Math.max(state.lastSeq, events.at(-1)?.seq ?? 0),
    drafts: drafts.length === state.drafts.length ? state.drafts : drafts,
    finalized,
    closedRuns,
    progress: state.progress,
    ...runPhase(events),
  };
}

/** A channel's text after a delta at `offset`: what it already holds is not added twice. */
function appendAt(have: string, text: string, offset: number | undefined): string {
  if (offset === undefined || offset >= have.length) return have + text;
  return offset + text.length <= have.length ? have : have + text.slice(have.length - offset);
}

function applyDelta(state: ChatState, d: StreamDelta): ChatState {
  const key = stepKey(d.runId, d.step);
  if (state.finalized[key] || state.closedRuns[d.runId]) return state;
  const i = state.drafts.findIndex((x) => x.runId === d.runId && x.step === d.step);
  const without = () =>
    i < 0 ? state : { ...state, drafts: state.drafts.filter((_, j) => j !== i) };
  if (d.delta === "step_reset") return without();
  let next: Draft;
  if (d.delta === "draft") {
    const prev = i >= 0 ? (state.drafts[i] as Draft) : undefined;
    // a channel left out is kept; a merge never shrinks what is shown; a resync keeps what is
    // shown when the stored draft is only behind it (a prefix), and replaces anything else
    const pick = (have: string, got: string | undefined) => {
      if (got === undefined) return have;
      if (d.resync) return have.startsWith(got) ? have : got;
      return !d.replace && got.length < have.length ? have : got;
    };
    next = {
      runId: d.runId,
      step: d.step,
      text: pick(prev?.text ?? "", d.text),
      thinking: pick(prev?.thinking ?? "", d.thinking),
    };
    if (next.text === "" && next.thinking === "") return without();
    if (prev !== undefined && next.text === prev.text && next.thinking === prev.thinking)
      return state;
  } else {
    const text = d.text ?? "";
    if (text === "") return state;
    const prev = i >= 0 ? (state.drafts[i] as Draft) : { ...d, text: "", thinking: "" };
    next = {
      runId: d.runId,
      step: d.step,
      text: d.delta === "text" ? appendAt(prev.text, text, d.offset) : prev.text,
      thinking: d.delta === "thinking" ? appendAt(prev.thinking, text, d.offset) : prev.thinking,
    };
    if (i >= 0 && next.text === prev.text && next.thinking === prev.thinking) return state;
  }
  const drafts =
    i >= 0 ? state.drafts.map((x, j) => (j === i ? next : x)) : [...state.drafts, next];
  return { ...state, drafts };
}

/**
 * 会话状态归约（纯函数）：
 * - 事件按 seq 合入，重复的忽略（乱序到达也按 seq 排列）；
 * - `delta` 累积到 `(runId, step)` 的流式草稿；`step_reset` 清空该步草稿；a `draft` sets its channels
 *   (`replace`), keeps a longer channel it is a prefix of (`resync`) or keeps the longer of each;
 *   a delta with an `offset` adds only what the draft does not hold yet;
 *   该步的 `assistant_message` 到达后草稿被它替换，之后再到的增量忽略（回放期间排队的增量可能晚到）；
 * - 运行到终态后丢弃其草稿、忽略其增量；`run_started` 之后、终态之前 `running` 为 true。
 * 没有变化时返回原 state。
 */
export function reduceChat(state: ChatState, input: ChatInput): ChatState {
  if (input.kind === "progress") {
    const p = input.progress;
    const prev = state.progress[p.subagentId];
    if (input.seed) {
      if (prev !== undefined && prev.toolCalls >= p.toolCalls) return state;
      const next = prev === undefined ? p : { ...prev, toolCalls: p.toolCalls };
      return { ...state, progress: { ...state.progress, [p.subagentId]: next } };
    }
    // stream messages can arrive out of order: keep the furthest step
    if (prev !== undefined && prev.step > p.step) return state;
    return { ...state, progress: { ...state.progress, [p.subagentId]: p } };
  }
  if (input.kind === "deltas") return input.deltas.reduce(applyDelta, state);
  return input.kind === "events"
    ? mergeEvents(state, input.events)
    : applyDelta(state, input.delta);
}
