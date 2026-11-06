import type { ModelMessage } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import {
  type ConversationEvent,
  type EventPayload,
  isAbsorbable,
} from "../../src/conversations/events.js";
import { buildModelRequest } from "../../src/runtime/context/build.js";
import { compactionPlan } from "../../src/runtime/context/compaction.js";
import { renderSubagentDelivery } from "../../src/runtime/subagents/render.js";
import { agentResultText } from "../../src/tools/builtins/agent.js";
import { AGENT, Log, MODEL } from "./context/fixtures.js";

/**
 * A sub-agent's delivery reaches its parent's model (spec 2026-11-06-agent-map-design §4.5): the
 * `subagent_delivery` event is absorbed like an interjection, through the same placement as
 * `background_task_finished` (`absorbedUpToSeq`, inline / deferred / skip), and rendered as a
 * system message.
 */

const REPORT: EventPayload<"subagent_delivery"> = {
  subagentId: "sa_7f3k",
  childRunId: "run-child-1",
  description: "Survey the auth module",
  kind: "report",
  text: "Found 3 call sites.\nAll use the old token API.",
  triggerAccountId: "acc-1",
};

const REPORT_TEXT =
  'Sub-agent sa_7f3k ("Survey the auth module") handed back a report:\n' +
  "Found 3 call sites.\nAll use the old token API.";

const delivered = (log: Log, over: Partial<EventPayload<"subagent_delivery">> = {}) =>
  log.add({ type: "subagent_delivery", payload: { ...REPORT, ...over } }, null);

/** A step's tool call and its result (step `step` of run-1). */
function toolStep(log: Log, step: number, id: string): void {
  log.assistant([{ type: "tool_call", id, name: "count", input: {} }], "tool_use", step);
  log.add({
    type: "tool_result",
    payload: { step, callId: id, toolKey: "count", content: `result ${id}`, isError: false },
  });
}

const build = (log: Log, absorbedUpToSeq: number | undefined, step = 2) =>
  buildModelRequest({
    events: log.events,
    agent: AGENT,
    agentVersion: 1,
    model: MODEL,
    step,
    ...(absorbedUpToSeq !== undefined && { absorbedUpToSeq }),
  });

const roles = (messages: ModelMessage[]) => messages.map((m) => m.role);

/** The status part of agentResultText's bracket line for `status`. */
const statusOf = (status: EventPayload<"subagent_finished">["status"]): string => {
  const { content } = agentResultText({
    reply: "r",
    agentId: "x",
    status,
    toolCalls: 0,
    durationMs: 0,
    tokens: 0,
  });
  return (content.split("[agentId: x · ")[1] as string).split(" · ")[0] as string;
};

describe("renderSubagentDelivery", () => {
  it("renders a report", () => {
    expect(renderSubagentDelivery(REPORT)).toBe(REPORT_TEXT);
  });

  it("renders a note", () => {
    expect(renderSubagentDelivery({ ...REPORT, kind: "note", text: "Halfway there." })).toBe(
      'Sub-agent sa_7f3k ("Survey the auth module") sent a message:\nHalfway there.',
    );
  });

  it("renders a finish after a handback as one line", () => {
    expect(
      renderSubagentDelivery({
        ...REPORT,
        kind: "finished",
        text: "",
        status: "completed",
        handedBack: true,
      }),
    ).toBe(
      'Sub-agent sa_7f3k ("Survey the auth module") completed; its report was already delivered.',
    );
  });

  it("renders a finish without a handback with the final reply", () => {
    expect(
      renderSubagentDelivery({
        ...REPORT,
        kind: "finished",
        status: "completed",
        text: "All done.",
      }),
    ).toBe('Sub-agent sa_7f3k ("Survey the auth module") completed. Final reply:\nAll done.');
  });

  it("failed / stopped / max_steps / budget statuses use the agentResultText wording", () => {
    const head = 'Sub-agent sa_7f3k ("Survey the auth module")';
    const fin = (status: EventPayload<"subagent_finished">["status"], text = "partial") =>
      renderSubagentDelivery({ ...REPORT, kind: "finished", status, text });
    expect(fin("max_steps")).toBe(
      `${head} stopped at the step limit; the reply may be partial. Final reply:\npartial`,
    );
    expect(fin("max_steps")).toContain(statusOf("max_steps"));
    expect(fin("budget")).toBe(`${head} stopped: token budget used up. Final reply:\npartial`);
    expect(fin("budget")).toContain(statusOf("budget"));
    expect(fin("aborted", "")).toBe(`${head} stopped by the user. It produced no reply.`);
    expect(fin("aborted", "")).toContain(statusOf("aborted"));
    expect(fin("failed", "")).toBe(`${head} failed. It produced no reply.`);
    expect(fin("failed", "")).toContain(statusOf("failed"));
    // after a handback only the status itself, without the partial-reply caveat
    expect(
      renderSubagentDelivery({
        ...REPORT,
        kind: "finished",
        status: "max_steps",
        text: "",
        handedBack: true,
      }),
    ).toBe(`${head} stopped at the step limit; its report was already delivered.`);
  });

  it("quotes a description holding quotes", () => {
    expect(renderSubagentDelivery({ ...REPORT, description: 'Say "hi"', text: "x" })).toBe(
      'Sub-agent sa_7f3k ("Say \\"hi\\"") handed back a report:\nx',
    );
  });
});

describe("placement in the request", () => {
  it("is absorbable", () => {
    const log = new Log();
    expect(isAbsorbable(delivered(log))).toBe(true);
  });

  it("a delivery is placed like background_task_finished (inline / deferred by absorbedUpToSeq)", () => {
    // inline: between steps, right after the tool results of the step before
    const inline = new Log();
    const q = inline.user("q");
    inline.modelCall(q.seq, 1);
    toolStep(inline, 1, "c1");
    const d = delivered(inline);
    const a = build(inline, d.seq);
    expect(roles(a.request.messages)).toEqual(["user", "assistant", "user", "system"]);
    expect(a.request.messages.at(-1)).toEqual({ role: "system", content: REPORT_TEXT });
    expect(a.meta.absorbedUpToSeq).toBe(d.seq);

    // deferred: landed during step 1's model call, placed after its tool results at step 2
    const log = new Log();
    const q2 = log.user("q");
    log.modelCall(q2.seq, 1);
    const d2 = delivered(log);
    toolStep(log, 1, "c1");
    const step2 = build(log, d2.seq);
    expect(roles(step2.request.messages)).toEqual(["user", "assistant", "user", "system"]);
    expect(step2.request.messages.at(-1)).toEqual({ role: "system", content: REPORT_TEXT });
    log.modelCall(d2.seq, 2);
    toolStep(log, 2, "c2");
    const step3 = build(log, d2.seq, 3);
    expect(step3.request.messages.slice(0, step2.request.messages.length)).toEqual(
      step2.request.messages,
    );

    // not absorbed: in no request
    const idle = new Log();
    const q3 = idle.user("q");
    idle.modelCall(q3.seq, 1);
    idle.assistant("done");
    delivered(idle);
    expect(roles(build(idle, q3.seq).request.messages)).toEqual(["user", "assistant"]);
  });

  it("a wake run's first request: the delivery after the earlier turn", () => {
    const log = new Log();
    const q = log.user("q");
    log.modelCall(q.seq, 1);
    log.assistant("dispatched it");
    log.add({ type: "run_finished", payload: { reason: "completed", consumedUpToSeq: q.seq } });
    log.runStarted();
    const d = delivered(log);
    const { request } = build(log, d.seq, 1);
    expect(request.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "q" }] },
      { role: "assistant", content: [{ type: "text", text: "dispatched it" }] },
      { role: "system", content: REPORT_TEXT },
    ]);
  });

  it("rebuilds the same request from the log slice and its recorded absorbedUpToSeq", () => {
    const log = new Log();
    const q = log.user("q");
    log.modelCall(q.seq, 1);
    const d = delivered(log);
    toolStep(log, 1, "c1");
    const original = build(log, d.seq);
    log.modelCall(original.meta.absorbedUpToSeq, 2, undefined, original.meta.toSeq);
    delivered(log, { kind: "note", text: "later" });
    const slice = log.events.filter(
      (e: ConversationEvent) => e.seq >= original.meta.fromSeq && e.seq <= original.meta.toSeq,
    );
    const again = buildModelRequest({
      events: slice,
      agent: AGENT,
      agentVersion: 1,
      model: MODEL,
      step: 2,
      absorbedUpToSeq: d.seq,
    });
    expect(again.request).toEqual(original.request);
    expect(again.meta).toEqual(original.meta);
  });

  it("a summary's transcript keeps a delivery", () => {
    const log = new Log();
    log.turn(1);
    delivered(log);
    log.turn(2);
    const plan = compactionPlan(log.events, 1);
    expect(plan?.transcript).toContain(`System reminder: ${REPORT_TEXT}`);
  });
});
