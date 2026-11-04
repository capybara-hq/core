import type { ModelMessage } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { renderBackgroundFinished } from "../../src/background/render.js";
import type { ConversationEvent, EventPayload } from "../../src/conversations/events.js";
import { buildModelRequest } from "../../src/runtime/context/build.js";
import { compactionPlan } from "../../src/runtime/context/compaction.js";
import { AGENT, Log, MODEL } from "./context/fixtures.js";

/**
 * A finished background task reaches the model (spec 2026-11-05-background-bash-design §2.4): the
 * `background_task_finished` event is absorbed like an interjection, through the same placement
 * (`absorbedUpToSeq`, inline / deferred / skip), and rendered as a system message.
 */

const FINISHED: EventPayload<"background_task_finished"> = {
  taskId: "bt_k3f9a2",
  description: "Run the test suite",
  status: "completed",
  exitCode: 1,
  elapsedMs: 252_000,
  lastLines: "FAIL a.test.ts\n2 failed\n",
  outputPath: "/workspace/.capybara/tasks/bt_k3f9a2.out",
  reported: false,
};

const SPEC_TEXT = [
  'Background task bt_k3f9a2 ("Run the test suite") completed with exit code 1 after 4m12s.',
  "Last lines:",
  "FAIL a.test.ts",
  "2 failed",
  "Full output: /workspace/.capybara/tasks/bt_k3f9a2.out",
].join("\n");

const finished = (log: Log, over: Partial<EventPayload<"background_task_finished">> = {}) =>
  log.add({ type: "background_task_finished", payload: { ...FINISHED, ...over } }, null);

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

describe("renderBackgroundFinished", () => {
  it("renders spec §2.4's text", () => {
    expect(renderBackgroundFinished(FINISHED)).toBe(SPEC_TEXT);
  });

  it("names a lost task's reason, leaves out a missing exit code and says when there was no output", () => {
    expect(
      renderBackgroundFinished({
        ...FINISHED,
        status: "lost",
        exitCode: null,
        elapsedMs: 3_000,
        lastLines: "",
        lostReason: "sandbox_suspended",
      }),
    ).toBe(
      [
        'Background task bt_k3f9a2 ("Run the test suite") lost (the sandbox was suspended) after 3s.',
        "Last lines: (none)",
        "Full output: /workspace/.capybara/tasks/bt_k3f9a2.out",
      ].join("\n"),
    );
    expect(renderBackgroundFinished({ ...FINISHED, status: "timed_out", exitCode: 137 })).toMatch(
      /^Background task bt_k3f9a2 \("Run the test suite"\) timed out with exit code 137 after 4m12s\.\n/,
    );
  });

  it("a finish a tool call already reported is one short line", () => {
    expect(renderBackgroundFinished({ ...FINISHED, status: "stopped", reported: true })).toBe(
      'Background task bt_k3f9a2 ("Run the test suite") stopped; already reported.',
    );
  });

  it("quotes a description holding quotes", () => {
    expect(renderBackgroundFinished({ ...FINISHED, description: 'Say "hi"', reported: true })).toBe(
      'Background task bt_k3f9a2 ("Say \\"hi\\"") completed; already reported.',
    );
  });
});

describe("placement in the request", () => {
  it("a finish between steps is a system message right after the tool results of the step before", () => {
    const log = new Log();
    const q = log.user("q");
    log.modelCall(q.seq, 1);
    toolStep(log, 1, "c1");
    const f = finished(log);
    const { request, meta } = build(log, f.seq);
    expect(roles(request.messages)).toEqual(["user", "assistant", "user", "system"]);
    expect(request.messages.at(-2)?.content).toEqual([
      { type: "tool_result", callId: "c1", content: "result c1", isError: false },
    ]);
    expect(request.messages.at(-1)).toEqual({ role: "system", content: SPEC_TEXT });
    expect(meta.absorbedUpToSeq).toBe(f.seq);
  });

  it("a finish during a model call is deferred to the call that absorbed it, after the tool results", () => {
    const log = new Log();
    const q = log.user("q");
    log.modelCall(q.seq, 1);
    // landed while step 1's model call ran: that request did not have it
    const f = finished(log);
    toolStep(log, 1, "c1");
    const step2 = build(log, f.seq);
    expect(roles(step2.request.messages)).toEqual(["user", "assistant", "user", "system"]);
    expect(step2.request.messages.at(-1)).toEqual({ role: "system", content: SPEC_TEXT });
    // the next step keeps it where step 2 sent it: the history is append-only
    log.modelCall(f.seq, 2);
    toolStep(log, 2, "c2");
    const step3 = build(log, f.seq, 3);
    expect(step3.request.messages.slice(0, step2.request.messages.length)).toEqual(
      step2.request.messages,
    );
  });

  it("an unabsorbed finish is in no request (it waits for the next step or run)", () => {
    const log = new Log();
    const q = log.user("q");
    log.modelCall(q.seq, 1);
    log.assistant("done");
    finished(log);
    const { request } = build(log, q.seq);
    expect(roles(request.messages)).toEqual(["user", "assistant"]);
  });

  it("a wake run's first request: the finish after the earlier turn, before the new model turn", () => {
    const log = new Log();
    const q = log.user("q");
    log.modelCall(q.seq, 1);
    log.assistant("started it");
    log.add({ type: "run_finished", payload: { reason: "completed", consumedUpToSeq: q.seq } });
    log.runStarted();
    const f = finished(log);
    const { request } = build(log, f.seq, 1);
    expect(request.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "q" }] },
      { role: "assistant", content: [{ type: "text", text: "started it" }] },
      { role: "system", content: SPEC_TEXT },
    ]);
  });

  it("keeps the log order of messages and finishes absorbed by the same call", () => {
    const log = new Log();
    const q = log.user("q");
    log.modelCall(q.seq, 1);
    const f = finished(log);
    const m = log.user("and also this");
    toolStep(log, 1, "c1");
    const { request } = build(log, m.seq);
    expect(roles(request.messages)).toEqual(["user", "assistant", "user", "system", "user"]);
    expect(request.messages.at(-2)).toEqual({ role: "system", content: SPEC_TEXT });
    expect(f.seq).toBeLessThan(m.seq);
  });

  it("a reported finish renders as the short line", () => {
    const log = new Log();
    const q = log.user("q");
    log.modelCall(q.seq, 1);
    toolStep(log, 1, "c1");
    const f = finished(log, { reported: true });
    const { request } = build(log, f.seq);
    expect(request.messages.at(-1)).toEqual({
      role: "system",
      content: 'Background task bt_k3f9a2 ("Run the test suite") completed; already reported.',
    });
  });

  it("rebuilds the same request from the log slice and its recorded absorbedUpToSeq", () => {
    const log = new Log();
    const q = log.user("q");
    log.modelCall(q.seq, 1);
    const f = finished(log);
    toolStep(log, 1, "c1");
    const original = build(log, f.seq);
    log.modelCall(original.meta.absorbedUpToSeq, 2, undefined, original.meta.toSeq);
    // later events change nothing in a rebuild of the recorded call
    finished(log, { taskId: "bt_zzzzzz" });
    log.user("later");
    const slice = log.events.filter(
      (e: ConversationEvent) => e.seq >= original.meta.fromSeq && e.seq <= original.meta.toSeq,
    );
    const again = buildModelRequest({
      events: slice,
      agent: AGENT,
      agentVersion: 1,
      model: MODEL,
      step: 2,
      absorbedUpToSeq: f.seq,
    });
    expect(again.request).toEqual(original.request);
    expect(again.meta).toEqual(original.meta);
  });

  it("a summary's transcript keeps a finished task", () => {
    const log = new Log();
    log.turn(1);
    finished(log);
    log.turn(2);
    const plan = compactionPlan(log.events, 1);
    expect(plan?.transcript).toContain(`System reminder: ${SPEC_TEXT}`);
  });
});
