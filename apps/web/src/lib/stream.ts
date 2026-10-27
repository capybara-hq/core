import {
  type ContentBlock,
  type ConversationEvent,
  type InputForm,
  type MessageAttachment,
  type ModelRef,
  type StopReason,
  type SubagentEndStatus,
  streamUrl,
  type ToolDisplay,
} from "./conversations";
import { parseUiRefresh, type UiRefresh } from "./ui";

/** SSE `event: delta` 帧：运行的流式增量（只是草稿，最终内容以日志中的 assistant_message 为准）。 */
export interface StreamDelta {
  runId: string;
  step: number;
  delta: "text" | "thinking" | "step_reset";
  text?: string;
}

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

interface Draft {
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
  | { kind: "progress"; progress: SubagentProgress };

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
    // stream messages can arrive out of order: keep the furthest step
    if (prev !== undefined && prev.step > p.step) return state;
    return { ...state, progress: { ...state.progress, [p.subagentId]: p } };
  }
  return input.kind === "events"
    ? mergeEvents(state, input.events)
    : applyDelta(state, input.delta);
}

// ---------------------------------------------------------------------------
// 列表项
// ---------------------------------------------------------------------------

export type ToolStatus = "pending" | "running" | "done" | "error" | "cancelled";

export type ApprovalDecision = Extract<ConversationEvent, { type: "approval_decided" }>["payload"];
export type QuestionOutcome = Extract<ConversationEvent, { type: "question_answered" }>["payload"];

export type ChatItem =
  | {
      kind: "user";
      key: string;
      text: string;
      attachments: MessageAttachment[];
      /** 上传的文件（image / document 引用块）。 */
      files: MessageFile[];
    }
  | {
      kind: "assistant";
      key: string;
      text: string;
      thinking: string;
      /**
       * 思考行「思考了 N 秒」的秒数。**是近似值**：日志里没有思考结束的时间，这里取整步的耗时
       * （该步 model_call 到 assistant_message），包含了输出正文与工具调用参数的时间。
       * 流式草稿与缺少 model_call 时为 null。
       */
      thinkingSeconds: number | null;
      stopReason: StopReason | null;
      streaming: boolean;
      /** 产出该消息的模型：该步的 `model_call`，没有时取运行的 `run_started`；都没有为 null。 */
      model: ModelRef | null;
    }
  | {
      kind: "tool";
      key: string;
      callId: string;
      /** 模型调用的工具名（即工具 key）。 */
      name: string;
      input: unknown;
      /** pending：尚未开始执行（如等审批）；cancelled：运行已结束却没有结果。 */
      status: ToolStatus;
      /** 结果正文（超长时内核已截为预览）。 */
      result: string | null;
      /** 完整结果的存档 id（结果被截断时有）。 */
      outputId: string | null;
      /** 工具给的显示摘要（没有时界面退回「工具名 + 输入前几个字段」）。 */
      display: ToolDisplay | null;
      /** An `agent` call that dispatched (or resumed) a sub-agent (from `subagent_*` events). */
      subagent?: SubagentInfo;
    }
  | {
      /**
       * A sub-agent waits for a person (`subagent_waiting`): its approval or question is acted on
       * in the parent with the existing cards; a connection is made in the sub-agent's view.
       */
      kind: "subagentWait";
      key: string;
      subagentId: string;
      /** The task name (`description`) of the sub-agent, else its type. */
      subagentName: string;
      wait: "approval" | "input" | "connect";
      approvalId?: string;
      questionId?: string;
      toolKey: string;
      expiresAt?: string;
    }
  | {
      kind: "approval";
      key: string;
      approvalId: string;
      callId: string;
      toolKey: string;
      /** 对应工具调用的参数（取自 assistant_message；找不到时为 undefined）。 */
      input: unknown;
      expiresAt: string;
      decided: ApprovalDecision | null;
    }
  | {
      kind: "question";
      key: string;
      questionId: string;
      callId: string;
      form: InputForm;
      expiresAt: string;
      answered: QuestionOutcome | null;
    }
  | {
      kind: "connect";
      key: string;
      callId: string;
      connectorId: string;
      connectorName: string;
      /** 所在运行已到终态（历史里的卡片不再提供「连接」）。 */
      closed: boolean;
    }
  | {
      kind: "failed";
      key: string;
      text: string;
      code: string;
      /** `run.hook_denied`: the plugin whose policy hook blocked the model request. */
      plugin?: string;
    };

/** What a sub-agent row shows: from the parent's `subagent_*` events and progress messages. */
export interface SubagentInfo {
  id: string;
  childRunId: string;
  agentType: string;
  description: string;
  resumed: boolean;
  /** `running` until its `subagent_finished`. */
  status: "running" | SubagentEndStatus;
  /** Tool calls of the sub-agent's run (progress while it runs; 0 before the first step). */
  toolCalls: number;
  /** Null while running. */
  durationMs: number | null;
  lastToolKey?: string;
}

/** 消息里上传的文件。 */
export interface MessageFile {
  attachmentId: string;
  kind: "image" | "document";
  mediaType: string;
  name: string;
}

/** user_message 里的 image / document 引用块（`base64` 来源不会进日志，忽略）。 */
function messageFiles(content: ContentBlock[]): MessageFile[] {
  return content.flatMap((b): MessageFile[] =>
    (b.type === "image" || b.type === "document") && b.source.kind === "ref"
      ? [
          {
            attachmentId: b.source.attachmentId,
            kind: b.type,
            mediaType: b.mediaType,
            name: b.name ?? b.source.attachmentId,
          },
        ]
      : [],
  );
}

const joinText = (blocks: { type: string; text?: string }[], type: "text" | "thinking") =>
  blocks
    .filter((b) => b.type === type)
    .map((b) => b.text ?? "")
    .join("");

type ToolItem = Extract<ChatItem, { kind: "tool" }>;

/**
 * 把状态展开为列表项：日志中的消息按 seq，流式草稿排在最后。
 * 工具调用紧跟产出它的 assistant 消息（只有工具调用、没有文字的消息不单独成卡），
 * 之后的 `tool_call_started` / `tool_result` 更新该项；审批、输入请求、需要连接按事件位置插入，
 * 处理结果（`approval_decided` / `question_answered`）回填到原项。
 */
export function chatItems(state: ChatState): ChatItem[] {
  const items: ChatItem[] = [];
  /** `runId` → 运行的模型；`runId:step` → 该步实际调用的模型（兜底时与运行的模型不同）。 */
  const models = new Map<string, ModelRef>();
  const modelOf = (runId: string | null, step: number): ModelRef | null =>
    runId === null ? null : (models.get(stepKey(runId, step)) ?? models.get(runId) ?? null);
  /** `runId:step` → 该步 model_call 的时间（算思考秒数）。 */
  const stepStarted = new Map<string, number>();
  /** (runId, callId) → 工具项：不同运行可能复用同一个 callId（与内核按 (runId, callId) 配对一致）。 */
  const tools = new Map<string, { item: ToolItem; runId: string | null }>();
  const toolKey = (runId: string | null, callId: string) => `${runId ?? ""}\u0000${callId}`;
  const approvals = new Map<string, number>();
  const questions = new Map<string, number>();
  /** subagentId → its latest dispatch's info (the row of that call). */
  const subagents = new Map<string, SubagentInfo>();
  /** runId → plugin of the latest model.request denial (named on that run's failure). */
  const modelDenials = new Map<string, string>();
  const replace = (i: number, next: ChatItem) => {
    items[i] = next;
  };
  for (const e of state.events) {
    const key = `e${e.seq}`;
    if (e.type === "run_started" && e.runId !== null) {
      models.set(e.runId, e.payload.model);
    } else if (e.type === "model_call" && e.runId !== null) {
      models.set(stepKey(e.runId, e.payload.step), {
        provider: e.payload.provider,
        model: e.payload.model,
      });
      stepStarted.set(stepKey(e.runId, e.payload.step), Date.parse(e.createdAt));
    } else if (e.type === "user_message") {
      // 带附件时只显示用户输入的文本（content[0]），附件正文不展开
      const attachments = e.payload.attachments ?? [];
      const text =
        attachments.length > 0
          ? joinText(e.payload.content.slice(0, 1), "text")
          : joinText(e.payload.content, "text");
      items.push({ kind: "user", key, text, attachments, files: messageFiles(e.payload.content) });
    } else if (e.type === "assistant_message") {
      const text = joinText(e.payload.content, "text");
      const thinking = joinText(e.payload.content, "thinking");
      const calls = e.payload.content.filter(
        (b): b is Extract<ContentBlock, { type: "tool_call" }> => b.type === "tool_call",
      );
      if (text !== "" || thinking !== "" || calls.length === 0) {
        const started =
          e.runId === null ? undefined : stepStarted.get(stepKey(e.runId, e.payload.step));
        const ended = Date.parse(e.createdAt);
        items.push({
          kind: "assistant",
          key,
          text,
          thinking,
          thinkingSeconds:
            started === undefined || Number.isNaN(started) || Number.isNaN(ended)
              ? null
              : Math.max(0, (ended - started) / 1000),
          stopReason: e.payload.stopReason,
          streaming: false,
          model: modelOf(e.runId, e.payload.step),
        });
      }
      for (const c of calls) {
        const item: ToolItem = {
          kind: "tool",
          key: `${key}:${c.id}`,
          callId: c.id,
          name: c.name,
          input: c.input,
          status: "pending",
          result: null,
          outputId: null,
          display: null,
        };
        tools.set(toolKey(e.runId, c.id), { item, runId: e.runId });
        items.push(item);
      }
    } else if (e.type === "tool_call_started") {
      const t = tools.get(toolKey(e.runId, e.payload.callId));
      if (t && t.item.status === "pending") t.item.status = "running";
    } else if (e.type === "tool_result") {
      const t = tools.get(toolKey(e.runId, e.payload.callId));
      if (t) {
        t.item.status = e.payload.isError ? "error" : "done";
        t.item.result = e.payload.content;
        t.item.outputId = e.payload.outputId ?? null;
        t.item.display = e.payload.display ?? null;
      }
    } else if (e.type === "approval_requested") {
      approvals.set(e.payload.approvalId, items.length);
      items.push({
        kind: "approval",
        key,
        approvalId: e.payload.approvalId,
        callId: e.payload.callId,
        toolKey: e.payload.toolKey,
        input: tools.get(toolKey(e.runId, e.payload.callId))?.item.input,
        expiresAt: e.payload.expiresAt,
        decided: null,
      });
    } else if (e.type === "approval_decided") {
      const i = approvals.get(e.payload.approvalId);
      const prev = i === undefined ? undefined : items[i];
      if (i !== undefined && prev?.kind === "approval") replace(i, { ...prev, decided: e.payload });
    } else if (e.type === "question_asked") {
      questions.set(e.payload.questionId, items.length);
      items.push({
        kind: "question",
        key,
        questionId: e.payload.questionId,
        callId: e.payload.callId,
        form: e.payload.form,
        expiresAt: e.payload.expiresAt,
        answered: null,
      });
    } else if (e.type === "question_answered") {
      const i = questions.get(e.payload.questionId);
      const prev = i === undefined ? undefined : items[i];
      if (i !== undefined && prev?.kind === "question")
        replace(i, { ...prev, answered: e.payload });
    } else if (e.type === "connection_required") {
      items.push({
        kind: "connect",
        key,
        callId: e.payload.callId,
        connectorId: e.payload.appId,
        connectorName: e.payload.appName,
        closed: e.runId !== null && state.closedRuns[e.runId] === true,
      });
    } else if (e.type === "subagent_dispatched") {
      const t = tools.get(toolKey(e.runId, e.payload.callId));
      const p = state.progress[e.payload.subagentId];
      const info: SubagentInfo = {
        id: e.payload.subagentId,
        childRunId: e.payload.childRunId,
        agentType: e.payload.agentType,
        description: e.payload.description,
        resumed: e.payload.resumed,
        status: "running",
        toolCalls: p?.toolCalls ?? 0,
        durationMs: null,
        ...(p?.lastToolKey !== undefined && { lastToolKey: p.lastToolKey }),
      };
      subagents.set(e.payload.subagentId, info);
      if (t) t.item.subagent = info;
    } else if (e.type === "subagent_finished") {
      const info = subagents.get(e.payload.subagentId);
      if (info !== undefined && info.childRunId === e.payload.childRunId) {
        info.status = e.payload.status;
        info.toolCalls = e.payload.toolCalls;
        info.durationMs = e.payload.durationMs;
      }
    } else if (e.type === "subagent_waiting") {
      const info = subagents.get(e.payload.subagentId);
      items.push({
        kind: "subagentWait",
        key,
        subagentId: e.payload.subagentId,
        subagentName: info?.description || info?.agentType || e.payload.subagentId,
        wait: e.payload.kind,
        toolKey: e.payload.toolKey,
        ...(e.payload.approvalId !== undefined && { approvalId: e.payload.approvalId }),
        ...(e.payload.questionId !== undefined && { questionId: e.payload.questionId }),
        ...(e.payload.expiresAt !== undefined && { expiresAt: e.payload.expiresAt }),
      });
    } else if (e.type === "hook_denied") {
      if (e.payload.mount === "model.request" && e.runId !== null) {
        modelDenials.set(e.runId, e.payload.plugin);
      }
    } else if (e.type === "run_failed") {
      const plugin =
        e.payload.error.code === "run.hook_denied" && e.runId !== null
          ? modelDenials.get(e.runId)
          : undefined;
      const code = e.payload.error.code;
      items.push({
        kind: "failed",
        key,
        // the pinned-skill failure's message names the unreadable skill for the agent's owner
        text: code === "storage.unavailable" ? e.payload.error.message : "",
        code,
        ...(plugin !== undefined && { plugin }),
      });
    }
  }
  // 运行已到终态却没有结果的调用（中止、失败）：不再显示为进行中
  for (const { item, runId } of tools.values()) {
    if (item.result === null && runId !== null && state.closedRuns[runId]) {
      item.status = "cancelled";
    }
  }
  for (const d of state.drafts) {
    if (d.text === "" && d.thinking === "") continue;
    items.push({
      kind: "assistant",
      key: `d${d.runId}:${d.step}`,
      text: d.text,
      thinking: d.thinking,
      thinkingSeconds: null,
      stopReason: null,
      streaming: true,
      model: modelOf(d.runId, d.step),
    });
  }
  return items;
}
