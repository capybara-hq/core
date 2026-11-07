import { describe, expect, it } from "vitest";
import type { ConversationEvent } from "../src/lib/conversations";
import {
  buildEventTimeline,
  buildTimeline,
  type TimelineDraft,
  type TimelineEntry,
  withDrafts,
} from "../src/lib/timeline";

// Run input spec D4: a message sent while a run is going stands where the model took it in.

let t = 0;
function ev(seq: number, type: string, payload: unknown, runId: string | null = "r1") {
  t += 1000;
  return {
    conversationId: "c1",
    seq,
    type,
    payload,
    runId,
    createdAt: new Date(t).toISOString(),
  } as ConversationEvent;
}
const user = (seq: number, text: string, extra: Record<string, unknown> = {}) =>
  ev(
    seq,
    "user_message",
    { content: [{ type: "text", text }], authorAccountId: "a1", ...extra },
    null,
  );
const runStarted = (seq: number, runId = "r1") =>
  ev(seq, "run_started", { agentVersion: 1, model: { provider: "p", model: "m" } }, runId);
const modelCall = (seq: number, step: number, absorbedUpToSeq: number, runId = "r1") =>
  ev(seq, "model_call", { step, provider: "p", model: "m", request: { absorbedUpToSeq } }, runId);
const reply = (seq: number, step: number, text: string, runId = "r1") =>
  ev(
    seq,
    "assistant_message",
    { step, stopReason: "end_turn", content: [{ type: "text", text }] },
    runId,
  );
const toolUse = (seq: number, step: number, callId: string) =>
  ev(seq, "assistant_message", {
    step,
    stopReason: "tool_use",
    content: [{ type: "tool_call", id: callId, name: "Bash", input: { command: "ls" } }],
  });
const toolResult = (seq: number, step: number, callId: string) =>
  ev(seq, "tool_result", { step, callId, toolKey: "Bash", content: "ok", isError: false });
const finished = (seq: number, consumedUpToSeq: number, runId = "r1") =>
  ev(seq, "run_finished", { consumedUpToSeq }, runId);

/** Each entry as `kind` plus what tells it apart (a bubble's text, prose, pending). */
const shape = (entries: TimelineEntry[]) =>
  entries.map((e) =>
    e.kind === "user"
      ? `user:${e.text}${e.pending ? " (pending)" : ""}`
      : e.kind === "prose"
        ? `prose:${e.text}${e.streaming ? " (draft)" : ""}`
        : e.kind,
  );

const timeline = (events: ConversationEvent[], drafts: TimelineDraft[] = []) =>
  buildTimeline(events, drafts, new Map(), "zh");

describe("interjections (spec D4)", () => {
  // The maintainer's case (spec §1): "哈哈" sent while the single-step reply streams.
  const asked = [user(1, "你能理解你自己吗？"), runStarted(2), modelCall(3, 1, 1)];

  it("the maintainer's case, live: pending below the streaming reply", () => {
    const events = [...asked, user(4, "哈哈")];
    const draft: TimelineDraft = { runId: "r1", step: 1, text: "我可以", thinking: "" };
    expect(shape(timeline(events, [draft]))).toEqual([
      "user:你能理解你自己吗？",
      "prose:我可以 (draft)",
      "user:哈哈 (pending)",
    ]);
    // the step's reply lands, the run still going: the bubble stays below it, still pending
    const logged = [...events, reply(5, 1, "我可以理解。")];
    expect(shape(timeline(logged))).toEqual([
      "user:你能理解你自己吗？",
      "prose:我可以理解。",
      "user:哈哈 (pending)",
    ]);
  });

  it("the maintainer's case, from the log: below the reply it never saw, before the run it started", () => {
    const events = [
      ...asked,
      user(4, "哈哈"),
      reply(5, 1, "我可以理解。"),
      finished(6, 1),
      runStarted(7, "r2"),
      modelCall(8, 1, 4, "r2"),
      reply(9, 1, "哈哈，是的。", "r2"),
      finished(10, 4, "r2"),
    ];
    expect(shape(timeline(events))).toEqual([
      "user:你能理解你自己吗？",
      "prose:我可以理解。",
      "run",
      "user:哈哈",
      "prose:哈哈，是的。",
      "run",
    ]);
    // between the two runs (the next one not started yet) it already stands after the run row,
    // no longer pending: no run is going
    expect(shape(timeline(events.slice(0, 6)))).toEqual([
      "user:你能理解你自己吗？",
      "prose:我可以理解。",
      "run",
      "user:哈哈",
    ]);
  });

  it("taken in after a tool step: below the step that was streaming, before the next one's output", () => {
    const events = [
      user(1, "列出文件"),
      runStarted(2),
      modelCall(3, 1, 1),
      // sent while step 1 streams; step 1 ends with a tool call
      user(4, "顺便看看隐藏文件"),
      toolUse(5, 1, "c1"),
      toolResult(6, 1, "c1"),
      modelCall(7, 2, 4),
      reply(8, 2, "好的，包括隐藏文件。"),
      finished(9, 4),
    ];
    expect(shape(timeline(events))).toEqual([
      "user:列出文件",
      "tools",
      "user:顺便看看隐藏文件",
      "prose:好的，包括隐藏文件。",
      "run",
    ]);
    // the next tool call opens a new group after the bubble
    const more = [...events.slice(0, 7), toolUse(8, 2, "c2")];
    expect(shape(timeline(more))).toEqual([
      "user:列出文件",
      "tools",
      "user:顺便看看隐藏文件",
      "tools",
    ]);
  });

  it("sent during a tool's run: pending until the next request takes it in", () => {
    const events = [
      user(1, "跑测试"),
      runStarted(2),
      modelCall(3, 1, 1),
      toolUse(4, 1, "c1"),
      user(5, "只跑单元测试"),
    ];
    const out = timeline(events);
    expect(shape(out)).toEqual(["user:跑测试", "tools", "user:只跑单元测试 (pending)"]);
    expect(out.at(-1)).toMatchObject({ key: "e5", seq: 5, pending: true });
    // the next step's draft streams from a request that took it in: no longer pending, above it
    const taken = [...events, toolResult(6, 1, "c1"), modelCall(7, 2, 5)];
    const draft: TimelineDraft = { runId: "r1", step: 2, text: "好的", thinking: "" };
    expect(shape(timeline(taken, [draft]))).toEqual([
      "user:跑测试",
      "tools",
      "user:只跑单元测试",
      "prose:好的 (draft)",
    ]);
  });

  it("a later request that did not take it in leaves it pending below that step's draft", () => {
    const events = [
      user(1, "a"),
      runStarted(2),
      modelCall(3, 1, 1),
      toolUse(4, 1, "c1"),
      toolResult(5, 1, "c1"),
      // step 2's request was built before the message arrived
      modelCall(6, 2, 1),
      user(7, "b"),
    ];
    const draft: TimelineDraft = { runId: "r1", step: 2, text: "…", thinking: "hmm" };
    expect(shape(timeline(events, [draft]))).toEqual([
      "user:a",
      "tools",
      "thinking",
      "prose:… (draft)",
      "user:b (pending)",
    ]);
  });

  it("a run stopped without taking it in: after the run's row, the trigger of the next run", () => {
    const events = [
      user(1, "a"),
      runStarted(2),
      modelCall(3, 1, 1),
      user(4, "b"),
      ev(5, "run_aborted", { byAccountId: "a1" }),
      runStarted(6, "r2"),
      modelCall(7, 1, 4, "r2"),
      reply(8, 1, "ok", "r2"),
    ];
    expect(shape(timeline(events))).toEqual(["user:a", "run", "user:b", "prose:ok"]);
  });

  it("a message sent while idle stays at its seq; older calls without the field took in all before them", () => {
    const events = [
      user(1, "a"),
      runStarted(2),
      ev(3, "model_call", { step: 1, provider: "p", model: "m" }),
      user(4, "b"),
      ev(5, "model_call", { step: 2, provider: "p", model: "m" }),
      reply(6, 2, "done"),
      finished(7, 4),
      user(8, "c"),
    ];
    expect(shape(timeline(events))).toEqual(["user:a", "user:b", "prose:done", "run", "user:c"]);
  });

  it("withDrafts keeps the log's entries and puts the drafts before the pending tail", () => {
    const base = buildEventTimeline([...asked, user(4, "哈哈"), user(5, "还有")], new Map(), "en");
    expect(withDrafts(base, [])).toBe(base.entries);
    const out = withDrafts(base, [{ runId: "r1", step: 1, text: "x", thinking: "" }]);
    expect(shape(out)).toEqual([
      "user:你能理解你自己吗？",
      "prose:x (draft)",
      "user:哈哈 (pending)",
      "user:还有 (pending)",
    ]);
    expect(out[0]).toBe(base.entries[0]);
    expect(out[2]).toBe(base.entries[1]);
  });
});
