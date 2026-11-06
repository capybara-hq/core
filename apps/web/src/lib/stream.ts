import { type ConversationEvent, streamUrl } from "./conversations";
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
 * - `draft`: the step's whole draft so far (`text` and `thinking`), replacing what is held. The
 *   stream opener produces it from an `event: draft` frame, from a draft read after a gap, and for
 *   the first delta of a step on a connection (spec 2026-11-07-run-input-and-live-drafts §4).
 */
export interface StreamDelta {
  runId: string;
  step: number;
  delta: "text" | "thinking" | "step_reset" | "draft";
  text?: string;
  /** `draft` only: the step's thinking so far. */
  thinking?: string;
  offset?: number;
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
 * The waits before each draft read of one gap (ms): the kernel may publish a delta up to its
 * coalescing window (200 ms) before the draft holding it is written, so a read can come back short.
 * After the last one the step's draft stays as it is until its `assistant_message`, a `step_reset`
 * or a reconnect's `event: draft` (never a draft with a hole in it).
 */
export const DRAFT_RETRY_MS: readonly number[] = [0, 100, 200, 400, 800, 1600];

type Channel = "text" | "thinking";

/** What one connection knows of a step's draft. */
interface StepDraft {
  text: string;
  thinking: string;
  /** The deltas past a gap, applied once a draft read covers up to them. */
  held: StreamDelta[];
  /** The draft reads of the current gap so far. */
  attempts: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** A read is in flight. */
  reading: boolean;
  /** The reads gave up: the step's deltas are dropped until something replaces its draft. */
  stale: boolean;
}

/**
 * The live drafts of one stream connection (spec 2026-11-07-run-input-and-live-drafts §4): turns
 * `event: draft` frames and offset-carrying deltas into gap-free updates for
 * {@link StreamHandlers.onDelta}. Per step and channel it keeps the draft it handed on, so it can
 * drop the deltas a draft already holds, trim an overlapping one, and hold the deltas past a gap
 * while it reads the run's drafts again (bounded, {@link DRAFT_RETRY_MS}). A step finalized by its
 * `assistant_message` on the stream, or of a run that ended, takes nothing more. Client state of
 * one browser connection only (nothing shared across requests).
 */
class LiveDrafts {
  private readonly steps = new Map<string, StepDraft>();
  private readonly finalized = new Set<string>();
  private readonly closedRuns = new Set<string>();
  /** Raised by every (re)open and the close: a read answered for an earlier one is dropped. */
  private epoch = 0;

  constructor(
    private readonly emit: (d: StreamDelta) => void,
    private readonly read: (runId: string) => Promise<RunDraftSnapshot[]>,
  ) {}

  /** A (re)connect: the server sends its `event: draft` frames again; earlier gaps are moot. */
  reset(): void {
    this.epoch++;
    for (const s of this.steps.values()) if (s.timer !== null) clearTimeout(s.timer);
    this.steps.clear();
  }

  event(e: ConversationEvent): void {
    if (e.runId === null) return;
    if (e.type === "assistant_message") {
      const key = stepKey(e.runId, e.payload.step);
      this.finalized.add(key);
      this.drop(key);
    } else if (TERMINAL.has(e.type)) {
      this.closedRuns.add(e.runId);
      for (const key of [...this.steps.keys()]) if (key.startsWith(`${e.runId}:`)) this.drop(key);
    }
  }

  /** `event: draft`: the step's draft at the open, replacing what this connection held. */
  draft(d: { runId: string; step: number; text: string; thinking: string }): void {
    const key = stepKey(d.runId, d.step);
    if (this.ignored(d.runId, key)) return;
    const held = this.steps.get(key)?.held ?? [];
    this.drop(key);
    const s = this.create(key, d.text, d.thinking);
    s.held = held;
    this.settle(d.runId, d.step, s);
  }

  delta(d: StreamDelta): void {
    const key = stepKey(d.runId, d.step);
    if (this.ignored(d.runId, key)) return;
    if (d.delta === "step_reset") {
      this.drop(key);
      this.emit(d);
      return;
    }
    if (d.delta === "draft") return;
    const text = d.text ?? "";
    // a delta without an offset (an older kernel): handed on as it is
    if (d.offset === undefined) {
      this.emit(d);
      return;
    }
    if (text === "") return;
    const ch: Channel = d.delta;
    let s = this.steps.get(key);
    if (s === undefined) {
      // the step's first delta on this connection replaces whatever an earlier one left
      if (d.offset === 0) {
        this.create(key, ch === "text" ? text : "", ch === "thinking" ? text : "");
        this.emit({
          runId: d.runId,
          step: d.step,
          delta: "draft",
          text: ch === "text" ? text : "",
          thinking: ch === "thinking" ? text : "",
        });
        return;
      }
      s = this.create(key, "", "");
    }
    if (s.stale) return;
    if (s.held.length > 0) {
      s.held.push(d);
      return;
    }
    const tail = this.append(s, ch, d.offset, text);
    if (tail === null) {
      s.held.push(d);
      this.readAgain(d.runId, d.step, s);
    } else if (tail !== "") {
      this.emit({ ...d, text: tail, offset: s[ch].length - tail.length });
    }
  }

  close(): void {
    this.reset();
  }

  private ignored(runId: string, key: string): boolean {
    return this.finalized.has(key) || this.closedRuns.has(runId);
  }

  private create(key: string, text: string, thinking: string): StepDraft {
    const s: StepDraft = {
      text,
      thinking,
      held: [],
      attempts: 0,
      timer: null,
      reading: false,
      stale: false,
    };
    this.steps.set(key, s);
    return s;
  }

  private drop(key: string): void {
    const s = this.steps.get(key);
    if (s?.timer != null) clearTimeout(s.timer);
    this.steps.delete(key);
  }

  /** Appends what is new of a delta: `""` when held already, `null` past a gap, else the tail. */
  private append(s: StepDraft, ch: Channel, offset: number, text: string): string | null {
    const have = s[ch].length;
    if (offset > have) return null;
    if (offset + text.length <= have) return "";
    const tail = text.slice(have - offset);
    s[ch] += tail;
    return tail;
  }

  /** Applies the held deltas that now follow on (in offset order); true when none is left. */
  private applyHeld(s: StepDraft): boolean {
    const held = [...s.held].sort((a, b) => (a.offset ?? 0) - (b.offset ?? 0));
    const left: StreamDelta[] = [];
    for (const d of held) {
      if (this.append(s, d.delta as Channel, d.offset ?? 0, d.text ?? "") === null) left.push(d);
    }
    // per channel, the deltas after the first one left past the gap are past it too
    s.held = left;
    return left.length === 0;
  }

  /** After the draft changed: hand on the whole of it, then read again while a gap is left. */
  private settle(runId: string, step: number, s: StepDraft): void {
    const covered = this.applyHeld(s);
    this.emit({ runId, step, delta: "draft", text: s.text, thinking: s.thinking });
    if (covered) {
      s.attempts = 0;
      if (s.timer !== null) clearTimeout(s.timer);
      s.timer = null;
    } else {
      this.readAgain(runId, step, s);
    }
  }

  /** Schedules the next draft read of a gap, or gives up after the last one. */
  private readAgain(runId: string, step: number, s: StepDraft): void {
    if (s.reading || s.timer !== null) return;
    const wait = DRAFT_RETRY_MS[s.attempts];
    if (wait === undefined) {
      s.held = [];
      s.stale = true;
      return;
    }
    s.attempts++;
    const epoch = this.epoch;
    const key = stepKey(runId, step);
    s.timer = setTimeout(() => {
      s.timer = null;
      if (epoch !== this.epoch || this.steps.get(key) !== s) return;
      s.reading = true;
      const done = (drafts: RunDraftSnapshot[]) => {
        s.reading = false;
        if (epoch !== this.epoch || this.steps.get(key) !== s) return;
        const got = drafts.find((x) => x.step === step);
        // the stored draft and what this connection holds are prefixes of one stream: the longer wins
        if (got !== undefined) {
          if (got.text.length > s.text.length) s.text = got.text;
          if (got.thinking.length > s.thinking.length) s.thinking = got.thinking;
        }
        this.settle(runId, step, s);
      };
      this.read(runId).then(done, () => done([]));
    }, wait);
  }
}

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
    // the step's whole draft so far: it replaces what is held (an empty one leaves nothing)
    const text = d.text ?? "";
    const thinking = d.thinking ?? "";
    if (text === "" && thinking === "") return without();
    next = { runId: d.runId, step: d.step, text, thinking };
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
 * - `delta` 累积到 `(runId, step)` 的流式草稿；`step_reset` 清空该步草稿；a `draft` replaces it;
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
