import { type ConversationEvent, streamUrl } from "./conversations";
import { parseUiRefresh, type UiRefresh } from "./ui";

/** SSE `event: delta` 帧：运行的流式增量（只是草稿，最终内容以日志中的 assistant_message 为准）。 */
export interface StreamDelta {
  runId: string;
  step: number;
  delta: "text" | "thinking" | "step_reset";
  text?: string;
}

/** What `event: changed` names (kernel `CONVERSATION_CHANGES`). */
export type ConversationChange = "title" | "queue" | "selection" | "files";
const CHANGES = new Set<string>(["title", "queue", "selection", "files"]);

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

export interface StreamHandlers {
  onEvent(e: ConversationEvent): void;
  onDelta(d: StreamDelta): void;
  /** `event: subagent_progress`: one of this conversation's sub-agents made progress. */
  onSubagentProgress?(p: SubagentProgress): void;
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
 */
export function openConversationStream(
  orgId: string,
  conversationId: string,
  afterSeq: number,
  handlers: StreamHandlers,
): () => void {
  const es = new EventSource(streamUrl(orgId, conversationId, afterSeq));
  let closed = false;
  const close = () => {
    closed = true;
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
    if (!closed) handlers.onOpen?.();
  });
  es.addEventListener("event", (e) => {
    const data = parse(e);
    if (!closed && data !== undefined) handlers.onEvent(data as ConversationEvent);
  });
  es.addEventListener("delta", (e) => {
    const data = parse(e);
    if (!closed && data !== undefined) handlers.onDelta(data as StreamDelta);
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

/** 等人处理的开始 / 结束事件（`waiting` 不是终态：处理后运行继续）。 */
const WAIT_START = new Set<ConversationEvent["type"]>(["approval_requested", "question_asked"]);
const WAIT_END = new Set<ConversationEvent["type"]>(["approval_decided", "question_answered"]);

function runPhase(events: ConversationEvent[]): { running: boolean; waiting: boolean } {
  let active: string | null = null;
  let waiting = false;
  for (const e of events) {
    if (e.type === "run_started") {
      active = e.runId;
      waiting = false;
    } else if (e.runId === null || e.runId !== active) {
    } else if (TERMINAL.has(e.type)) {
      active = null;
      waiting = false;
    } else if (WAIT_START.has(e.type)) {
      waiting = true;
    } else if (WAIT_END.has(e.type)) {
      waiting = false;
    }
  }
  return { running: active !== null && !waiting, waiting: active !== null && waiting };
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

function applyDelta(state: ChatState, d: StreamDelta): ChatState {
  const key = stepKey(d.runId, d.step);
  if (state.finalized[key] || state.closedRuns[d.runId]) return state;
  const i = state.drafts.findIndex((x) => x.runId === d.runId && x.step === d.step);
  if (d.delta === "step_reset") {
    if (i < 0) return state;
    return { ...state, drafts: state.drafts.filter((_, j) => j !== i) };
  }
  const text = d.text ?? "";
  if (text === "") return state;
  const prev = i >= 0 ? (state.drafts[i] as Draft) : { ...d, text: "", thinking: "" };
  const next: Draft = {
    runId: d.runId,
    step: d.step,
    text: d.delta === "text" ? prev.text + text : prev.text,
    thinking: d.delta === "thinking" ? prev.thinking + text : prev.thinking,
  };
  const drafts =
    i >= 0 ? state.drafts.map((x, j) => (j === i ? next : x)) : [...state.drafts, next];
  return { ...state, drafts };
}

/**
 * 会话状态归约（纯函数）：
 * - 事件按 seq 合入，重复的忽略（乱序到达也按 seq 排列）；
 * - `delta` 累积到 `(runId, step)` 的流式草稿；`step_reset` 清空该步草稿；
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
  return input.kind === "events"
    ? mergeEvents(state, input.events)
    : applyDelta(state, input.delta);
}
