import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationEvent } from "../src/lib/conversations";
import {
  type ChatState,
  chatItems,
  initialChatState,
  openConversationStream,
  reduceChat,
  type StreamDelta,
} from "../src/lib/stream";

const CONV = "c1";
const RUN = "r1";

let createdAt = 0;
function ev(
  seq: number,
  type: ConversationEvent["type"],
  payload: unknown,
  runId: string | null = RUN,
): ConversationEvent {
  createdAt += 1;
  return {
    conversationId: CONV,
    seq,
    type,
    payload,
    runId,
    createdAt: new Date(createdAt).toISOString(),
  } as ConversationEvent;
}

const user = (seq: number, text: string) =>
  ev(seq, "user_message", { content: [{ type: "text", text }], authorAccountId: "a1" }, null);
const started = (seq: number, runId = RUN) =>
  ev(
    seq,
    "run_started",
    { agentVersion: 1, model: { provider: "p", model: "m" }, triggerAccountId: "a1" },
    runId,
  );
const assistant = (seq: number, step: number, text: string, stopReason = "end_turn", runId = RUN) =>
  ev(seq, "assistant_message", { step, content: [{ type: "text", text }], stopReason }, runId);
const finished = (seq: number, runId = RUN) =>
  ev(seq, "run_finished", { reason: "completed", consumedUpToSeq: seq - 1 }, runId);
const aborted = (seq: number, runId = RUN) =>
  ev(seq, "run_aborted", { byAccountId: "a1", reason: "user" }, runId);

const delta = (text: string, step = 0, runId = RUN): StreamDelta => ({
  runId,
  step,
  delta: "text",
  text,
});

function apply(state: ChatState, ...inputs: (ConversationEvent[] | StreamDelta)[]): ChatState {
  let s = state;
  for (const input of inputs) {
    s = reduceChat(
      s,
      Array.isArray(input) ? { kind: "events", events: input } : { kind: "delta", delta: input },
    );
  }
  return s;
}

const texts = (s: ChatState) => chatItems(s).map((i) => `${i.kind}:${i.text}`);

describe("reduceChat", () => {
  it("事件按 seq 合入：乱序到达也按 seq 排列", () => {
    const s = apply(initialChatState, [assistant(3, 0, "hi")], [user(1, "hello"), started(2)]);
    expect(s.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(s.lastSeq).toBe(3);
    expect(texts(s)).toEqual(["user:hello", "assistant:hi"]);
  });

  it("重复事件被忽略（同 seq 第二次到达不重复显示）", () => {
    const s = apply(
      initialChatState,
      [user(1, "hello")],
      [user(1, "hello"), started(2)],
      [started(2)],
    );
    expect(s.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(texts(s)).toEqual(["user:hello"]);
  });

  it("delta 累积成当前步骤的流式草稿", () => {
    const s = apply(initialChatState, [user(1, "q"), started(2)], delta("hel"), delta("lo"));
    const items = chatItems(s);
    expect(items.at(-1)).toMatchObject({ kind: "assistant", text: "hello", streaming: true });
  });

  it("thinking 增量单独累积", () => {
    const s = apply(initialChatState, [started(1)], {
      runId: RUN,
      step: 0,
      delta: "thinking",
      text: "hmm",
    });
    expect(chatItems(s).at(-1)).toMatchObject({ thinking: "hmm", text: "", streaming: true });
  });

  it("step_reset 清空该步草稿", () => {
    const s = apply(initialChatState, [started(1)], delta("partial"), {
      runId: RUN,
      step: 0,
      delta: "step_reset",
    });
    expect(chatItems(s).filter((i) => i.kind === "assistant")).toEqual([]);
    const after = apply(s, delta("fresh"));
    expect(chatItems(after).at(-1)).toMatchObject({ text: "fresh", streaming: true });
  });

  it("对应 step 的 assistant_message 替换草稿", () => {
    const s = apply(initialChatState, [started(1)], delta("draft tex"), [
      assistant(2, 0, "final text"),
    ]);
    const items = chatItems(s);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "assistant", text: "final text", streaming: false });
  });

  it("只替换同一 step 的草稿：下一步的草稿保留", () => {
    const s = apply(initialChatState, [started(1)], delta("a", 0), delta("b", 1), [
      assistant(2, 0, "A"),
    ]);
    expect(texts(s)).toEqual(["assistant:A", "assistant:b"]);
  });

  it("已定稿的 (runId, step) 之后到达的 delta 被忽略（回放期间排队的增量）", () => {
    const s = apply(initialChatState, [started(1), assistant(2, 0, "final")], delta("late"));
    expect(texts(s)).toEqual(["assistant:final"]);
    // 不同 run 的同一 step 不受影响
    const other = apply(s, [started(3, "r2")], delta("new", 0, "r2"));
    expect(texts(other)).toEqual(["assistant:final", "assistant:new"]);
  });

  it("运行已到终态后到达的 delta 被忽略，终态时丢弃该运行的草稿", () => {
    const s = apply(initialChatState, [started(1)], delta("x"), [aborted(2)]);
    expect(chatItems(s).filter((i) => i.kind === "assistant")).toEqual([]);
    expect(texts(apply(s, delta("y")))).toEqual([]);
  });

  it("run_started 之后、终态之前为运行中", () => {
    let s = apply(initialChatState, [user(1, "q")]);
    expect(s.running).toBe(false);
    s = apply(s, [started(2)]);
    expect(s.running).toBe(true);
    s = apply(s, [assistant(3, 0, "a")]);
    expect(s.running).toBe(true);
    s = apply(s, [finished(4)]);
    expect(s.running).toBe(false);
  });

  it("乱序：终态先于 run_started 到达仍判定为未运行", () => {
    const s = apply(initialChatState, [finished(3)], [started(2)]);
    expect(s.running).toBe(false);
  });

  it("aborted 的 assistant_message 带 stopReason，run_failed 显示为失败项", () => {
    const s = apply(initialChatState, [
      started(1),
      assistant(2, 0, "part", "aborted"),
      aborted(3),
      started(4, "r2"),
      ev(5, "run_failed", { error: { code: "model.failed", message: "x" } }, "r2"),
    ]);
    const items = chatItems(s);
    expect(items[0]).toMatchObject({ kind: "assistant", text: "part", stopReason: "aborted" });
    expect(items[1]).toMatchObject({ kind: "failed", code: "model.failed" });
  });

  it("没有变化时返回同一个 state 引用", () => {
    const s = apply(initialChatState, [user(1, "q")]);
    expect(reduceChat(s, { kind: "events", events: [user(1, "q")] })).toBe(s);
  });
});

/** 极简 EventSource 桩：记录 URL，可手动派发帧。 */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly listeners = new Map<string, ((e: Event) => void)[]>();
  readyState = 0;
  closed = false;
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: Event) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  emit(type: string, data?: unknown) {
    const e =
      data === undefined ? new Event(type) : new MessageEvent(type, { data: JSON.stringify(data) });
    for (const fn of this.listeners.get(type) ?? []) fn(e);
  }
}

describe("openConversationStream", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeEventSource.instances = [];
  });

  it("订阅 stream 端点并把 event / delta 帧交给回调；返回的函数关闭连接", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const onEvent = vi.fn();
    const onDelta = vi.fn();
    const close = openConversationStream("o1", "c1", 7, { onEvent, onDelta });
    const es = FakeEventSource.instances[0];
    expect(es?.url).toBe("/api/v1/orgs/o1/conversations/c1/stream?after=7");
    es?.emit("event", user(8, "x"));
    es?.emit("delta", delta("hi"));
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ seq: 8 }));
    expect(onDelta).toHaveBeenCalledWith(delta("hi"));
    close();
    expect(es?.closed).toBe(true);
  });

  it("服务端 error 帧：关闭连接（不再重连）并带错误码回调", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const onError = vi.fn();
    openConversationStream("o1", "c1", 0, { onEvent: vi.fn(), onDelta: vi.fn(), onError });
    const es = FakeEventSource.instances[0];
    es?.emit("error", { code: "auth.session_revoked" });
    expect(es?.closed).toBe(true);
    expect(onError).toHaveBeenCalledWith({ code: "auth.session_revoked" });
  });

  it("连接建立（open）时回调 onOpen", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const onOpen = vi.fn();
    openConversationStream("o1", "c1", 0, { onEvent: vi.fn(), onDelta: vi.fn(), onOpen });
    FakeEventSource.instances[0]?.emit("open");
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("连接错误且浏览器已放弃重连（CLOSED）：回调不带错误码；仍在重连时不回调", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const onError = vi.fn();
    openConversationStream("o1", "c1", 0, { onEvent: vi.fn(), onDelta: vi.fn(), onError });
    const es = FakeEventSource.instances[0] as FakeEventSource;
    es.readyState = 0; // CONNECTING：浏览器自动重连中
    es.emit("error");
    expect(onError).not.toHaveBeenCalled();
    es.readyState = 2;
    es.emit("error");
    expect(onError).toHaveBeenCalledWith({});
  });
});
