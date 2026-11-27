import type { ModelInfo, ModelRequest, ParamValue } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import type { AgentDefinition } from "../../../src/agents/definition.js";
import type { ConversationEvent } from "../../../src/conversations/events.js";
import { reconstructRequest } from "../../../src/evals/reconstruct.js";
import { type CaseSnapshot, toEvents } from "../../../src/evals/snapshot.js";
import type { RequestTool } from "../../../src/runtime/context/build.js";
import {
  buildCompactionRequest,
  compactionRetryNote,
  SUMMARY_TASK_LINES,
  TRANSCRIPT_READING_LINES,
} from "../../../src/runtime/context/compaction.js";
import {
  buildInContextCompactionRequest,
  IN_CONTEXT_SUMMARY_MODELS,
  type InContextBoundary,
  inContextCoversUpToSeq,
  inContextInstruction,
  inContextSummaryAllowed,
  unansweredAfterReply,
  withInContextRetryNote,
} from "../../../src/runtime/context/in-context-compaction.js";
import { UNKNOWN_RESULT_TEXT } from "../../../src/runtime/context/pairing.js";
import { assembleModelRequest } from "../../../src/runtime/model-call.js";

/**
 * Idle compaction spec §9.4: the in-context summary request is the conversation's last request
 * rebuilt through the zero-drift path, extended with what the next step would send, plus one
 * summary instruction. Pure: the logs are built in memory the way the runtime records them.
 */

const ORG = "00000000-0000-4000-8000-000000000001";
const CONV = "00000000-0000-4000-8000-000000000002";
const RUN = "00000000-0000-4000-8000-000000000003";
const AT = "2026-11-28T00:00:00.000Z";

const MODEL: ModelInfo = {
  id: "fake-1",
  displayName: "Fake 1",
  contextWindow: 200_000,
  maxOutputTokens: 8192,
  capabilities: { tools: true, vision: false, reasoning: true, midConversationSystem: true },
  parameters: [],
  cache: {
    mechanism: "explicit",
    ttlOptions: [300, 3600],
    defaultTtl: 300,
    ttlIsMinimum: false,
    refreshOnHit: true,
    ttlClock: "request_start",
    guaranteed: true,
  },
};

const AGENT: AgentDefinition = {
  name: "Helper",
  avatarUrl: null,
  instructions: "You help with accounting questions.",
  model: { provider: "model-fake", model: "fake-1" },
  fallback: null,
  modelParams: {},
  fallbackParams: {},
  disabledSkills: [],
  disabledTools: [],
  toolPolicies: {},
};

const LOOKUP: RequestTool = {
  key: "Lookup",
  specHash: "hash-lookup",
  spec: {
    name: "Lookup",
    description: "Look up an account balance.",
    inputSchema: { type: "object", properties: { account: { type: "string" } } },
  },
};

const SUMMARY_CAP = 4000;

/** Builds a log as the runtime records it: each `model_call` carries what was sent. */
class Recorder {
  readonly events: CaseSnapshot["events"] = [];

  add(type: string, payload: unknown, runId: string | null = RUN): number {
    const seq = (this.events.at(-1)?.seq ?? 0) + 1;
    this.events.push({ seq, type, payload, runId, createdAt: AT } as CaseSnapshot["events"][0]);
    return seq;
  }

  user(text: string, extra: Record<string, unknown> = {}): number {
    return this.add(
      "user_message",
      { content: [{ type: "text", text }], authorAccountId: "acc-1", ...extra },
      null,
    );
  }

  started(): number {
    return this.add("run_started", {
      agentVersion: 1,
      model: { provider: "model-fake", model: "fake-1" },
      triggerAccountId: "acc-1",
    });
  }

  call(
    step: number,
    opts: { fit?: unknown; cacheTtl?: number; params?: Record<string, ParamValue> } = {},
  ): number {
    const events = toEvents(this.snapshot());
    const absorbed = Math.max(
      0,
      ...events.filter((e) => e.type === "user_message").map((e) => e.seq),
    );
    const { request, meta } = assembleModelRequest({
      events,
      agent: AGENT,
      agentVersion: 1,
      model: MODEL,
      step,
      absorbedUpToSeq: absorbed,
      params: opts.params ?? {},
      tools: [LOOKUP],
      toolSearch: false,
      ...(opts.cacheTtl !== undefined && { cacheTtl: opts.cacheTtl }),
      defaultMaxOutputTokens: 4096,
    });
    return this.add("model_call", {
      step,
      attempt: 1,
      provider: "model-fake",
      model: "fake-1",
      fallback: false,
      request: {
        ...meta,
        maxOutputTokens: request.maxOutputTokens,
        ...(opts.fit !== undefined && { fit: opts.fit }),
      },
    });
  }

  assistant(step: number, content: unknown[], stopReason = "end_turn"): number {
    return this.add("assistant_message", { step, content, stopReason });
  }

  toolCall(step: number, id: string): number {
    return this.assistant(
      step,
      [
        { type: "text", text: "Let me check." },
        { type: "tool_call", id, name: "Lookup", input: { account: "cash" } },
      ],
      "tool_use",
    );
  }

  toolResult(step: number, callId: string, content: string): number {
    return this.add("tool_result", { step, callId, toolKey: "Lookup", content, isError: false });
  }

  usage(step: number): number {
    return this.add("usage", {
      step,
      provider: "model-fake",
      model: "fake-1",
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 90,
      cacheWriteTokens: 0,
    });
  }

  finished(): number {
    return this.add("run_finished", {
      reason: "completed",
      consumedUpToSeq: this.events.at(-1)?.seq ?? 0,
    });
  }

  lastUserSeq(): number {
    return Math.max(...this.events.filter((e) => e.type === "user_message").map((e) => e.seq));
  }

  snapshot(): CaseSnapshot {
    return {
      version: 1,
      orgId: ORG,
      conversationId: CONV,
      runId: RUN,
      agentId: ORG,
      agentVersion: 1,
      source: "web",
      events: structuredClone(this.events),
      definitions: { "1": AGENT },
      toolSpecs: { [LOOKUP.specHash]: LOOKUP.spec },
    };
  }
}

/** A finished two-step run: a tool call, its result, then the final text. */
function finishedRun(r = new Recorder(), opts: { cacheTtl?: number } = {}): Recorder {
  r.user("What is my cash balance?");
  r.started();
  r.call(1, opts);
  r.toolCall(1, "call-1");
  r.usage(1);
  r.toolResult(1, "call-1", "120 EUR");
  r.call(2, opts);
  r.assistant(2, [{ type: "text", text: "Cash is 120 EUR." }]);
  r.usage(2);
  r.finished();
  return r;
}

/** A run stopped at a step boundary: the last reply called a tool and its result is logged. */
function midRun(): Recorder {
  const r = new Recorder();
  r.user("What is my cash balance?");
  r.started();
  r.call(1);
  r.toolCall(1, "call-1");
  r.usage(1);
  r.toolResult(1, "call-1", "120 EUR");
  return r;
}

const ALL: InContextBoundary = { mode: "all" };

function build(
  r: Recorder,
  over: Partial<Parameters<typeof buildInContextCompactionRequest>[0]> = {},
) {
  const snapshot = over.snapshot ?? r.snapshot();
  return buildInContextCompactionRequest({
    snapshot,
    events: toEvents(snapshot),
    absorbedUpToSeq: r.lastUserSeq(),
    model: MODEL,
    reserveTokens: 0,
    summaryCap: SUMMARY_CAP,
    boundary: ALL,
    retry: false,
    ...over,
  });
}

function built(r: Recorder, over: Parameters<typeof build>[1] = {}) {
  const out = build(r, over);
  if ("skip" in out) throw new Error(`skipped: ${out.skip}`);
  return out;
}

const lastCallSeq = (events: readonly { seq: number; type: string }[]) =>
  Math.max(...events.filter((e) => e.type === "model_call").map((e) => e.seq));

function reference(snapshot: CaseSnapshot): ModelRequest {
  const ref = reconstructRequest(snapshot, lastCallSeq(snapshot.events), { model: MODEL });
  expect(ref.drift).toEqual([]);
  return ref.request;
}

function expectPrefix(req: ModelRequest, ref: ModelRequest) {
  expect(req.model).toBe(ref.model);
  expect(req.system).toEqual(ref.system);
  expect(req.tools).toEqual(ref.tools);
  expect(req.params).toEqual(ref.params);
  expect(req.cacheTtl).toBe(ref.cacheTtl);
  expect("cacheTtl" in req).toBe("cacheTtl" in ref);
  expect(req.messages.slice(0, ref.messages.length)).toEqual(ref.messages);
}

describe("buildInContextCompactionRequest", () => {
  it("a finished run: the last request, its reply, then one instruction message", () => {
    const r = finishedRun(new Recorder(), { cacheTtl: 3600 });
    const snap = r.snapshot();
    const ref = reference(snap);
    expect(ref.cacheTtl).toBe(3600);
    const out = built(r);
    expectPrefix(out.request, ref);
    expect(out.request.messages.slice(ref.messages.length)).toEqual([
      { role: "assistant", content: [{ type: "text", text: "Cash is 120 EUR." }] },
      { role: "user", content: [{ type: "text", text: inContextInstruction(null) }] },
    ]);
    expect(out.request.toolChoice).toBe("none");
    expect(out.request.maxOutputTokens).toBe(SUMMARY_CAP);
    expect(out.request.purpose).toBe("compaction");
    expect(out.request.cacheTtl).toBe(3600);
    expect(out.lastCallSeq).toBe(lastCallSeq(snap.events));
    expect(out.estimate).toBeGreaterThan(0);
    // nothing else differs from the reference
    const { messages: _m, maxOutputTokens: _o, purpose: _p, toolChoice: _t, ...rest } = out.request;
    const { messages: _rm, maxOutputTokens: _ro, purpose: _rp, toolChoice: _rt, ...restRef } = ref;
    expect(rest).toEqual(restRef);
  });

  it("a mid-run step boundary: the tool result follows the reply and carries the instruction", () => {
    const r = midRun();
    const ref = reference(r.snapshot());
    const out = built(r);
    expectPrefix(out.request, ref);
    const added = out.request.messages.slice(ref.messages.length);
    expect(added).toHaveLength(2);
    expect(added[0]?.role).toBe("assistant");
    expect(added[1]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", callId: "call-1", content: "120 EUR", isError: false },
        { type: "text", text: inContextInstruction(null) },
      ],
    });
  });

  it("an aborted last reply with an unpaired tool call: paired as unknown, instruction after it", () => {
    const r = new Recorder();
    r.user("What is my cash balance?");
    r.started();
    r.call(1);
    r.assistant(
      1,
      [
        { type: "text", text: "Let me check." },
        { type: "tool_call", id: "call-1", name: "Lookup", input: { account: "cash" } },
        { type: "tool_call", id: "call-2", name: "Lookup", input: { account: "savings" } },
      ],
      "aborted",
    );
    r.usage(1);
    const ref = reference(r.snapshot());
    const out = built(r);
    expectPrefix(out.request, ref);
    const added = out.request.messages.slice(ref.messages.length);
    expect(added).toHaveLength(2);
    expect(added[0]?.role).toBe("assistant");
    // every tool call of the request has its result (the pairing guard's unknown one)
    expect(added[1]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", callId: "call-1", content: UNKNOWN_RESULT_TEXT, isError: true },
        { type: "tool_result", callId: "call-2", content: UNKNOWN_RESULT_TEXT, isError: true },
        { type: "text", text: inContextInstruction(null) },
      ],
    });
    const calls = out.request.messages.flatMap((m) =>
      m.role === "system" ? [] : m.content.flatMap((b) => (b.type === "tool_call" ? [b.id] : [])),
    );
    const results = new Set(
      out.request.messages.flatMap((m) =>
        m.role === "system"
          ? []
          : m.content.flatMap((b) => (b.type === "tool_result" ? [b.callId] : [])),
      ),
    );
    expect(calls.every((id) => results.has(id))).toBe(true);
  });

  it("keeps the recorded cacheTtl absence even when the model offers the long tier", () => {
    // the last call asked for no tier (the org had longTtl off then); whatever the setting now,
    // the summary request asks for what the cached prefix was written with
    const r = finishedRun();
    const out = built(r);
    expect("cacheTtl" in out.request).toBe(false);
  });

  it("skips a reference with a fit plan", () => {
    const r = new Recorder();
    r.user("hi");
    r.started();
    r.call(1, { fit: { dropBefore: 1, truncate: [] } });
    r.assistant(1, [{ type: "text", text: "Hello." }]);
    expect(build(r)).toEqual({ skip: "fit_plan" });
  });

  it("skips without a model call", () => {
    const r = new Recorder();
    r.user("hi");
    expect(build(r)).toEqual({ skip: "no_model_call" });
  });

  it("skips when the compaction model is not the last call's model", () => {
    expect(build(finishedRun(), { model: { ...MODEL, id: "fake-2" } })).toEqual({
      skip: "model_mismatch",
    });
  });

  it("skips a drifted snapshot (a tool spec missing)", () => {
    const r = finishedRun();
    const snapshot = { ...r.snapshot(), toolSpecs: {} };
    expect(build(r, { snapshot })).toEqual({ skip: "drift" });
  });

  it("skips when the extension changes the system prompt", () => {
    const r = finishedRun();
    const snapshot = r.snapshot();
    // a skills catalog the recorded requests never saw: it lands in the first system block
    const catalog = {
      conversationId: CONV,
      seq: 2.5,
      type: "skills_catalog",
      runId: RUN,
      createdAt: new Date(AT),
      payload: {
        skills: [
          {
            id: "id-a",
            name: "alpha",
            description: "Use for alpha tasks.",
            version: 1,
            source: "skills/a/",
          },
        ],
      },
    } as unknown as ConversationEvent;
    const events = [...toEvents(snapshot), catalog].sort((a, b) => a.seq - b.seq);
    expect(build(r, { snapshot, events })).toEqual({ skip: "prefix_mismatch" });
  });

  it("skips when the request with the summary cap does not fit", () => {
    const r = finishedRun();
    const { estimate } = built(r);
    const edge = MODEL.contextWindow - estimate - SUMMARY_CAP;
    expect("request" in build(r, { reserveTokens: edge })).toBe(true);
    expect(build(r, { reserveTokens: edge + 1 })).toEqual({ skip: "too_large" });
  });

  it("retry adds the retry note after the instruction and nothing else", () => {
    const r = finishedRun();
    const first = built(r);
    const retry = built(r, { retry: true });
    const n = first.request.messages.length;
    expect(retry.request.messages).toHaveLength(n);
    expect(retry.request.messages.slice(0, n - 1)).toEqual(first.request.messages.slice(0, n - 1));
    expect(retry.request.messages[n - 1]).toEqual({
      role: "user",
      content: [
        { type: "text", text: inContextInstruction(null) },
        { type: "text", text: compactionRetryNote(SUMMARY_CAP) },
      ],
    });
    const { messages: _a, ...restRetry } = retry.request;
    const { messages: _b, ...restFirst } = first.request;
    expect(restRetry).toEqual(restFirst);
  });

  it("the runtime's retry form (the note appended to a copy) equals the builder's retry request", () => {
    for (const r of [finishedRun(), midRun()]) {
      const first = built(r);
      const before = structuredClone(first.request);
      expect(withInContextRetryNote(first.request, SUMMARY_CAP)).toEqual(
        built(r, { retry: true }).request,
      );
      // the first request is left as it was
      expect(first.request).toEqual(before);
    }
  });
});

describe("buildInContextCompactionRequest: a marked boundary", () => {
  /** Two finished turns; the second opens with `second` from a named sender. */
  function twoTurns(first: string, second: string): { r: Recorder; keptSeq: number } {
    const r = new Recorder();
    r.user(first, { sender: { name: "Grant", role: "owner" } });
    r.started();
    r.call(1);
    r.assistant(1, [{ type: "text", text: "Done." }]);
    r.usage(1);
    r.finished();
    const keptSeq = r.user(second, { sender: { name: "Ada", role: "member" } });
    r.started();
    r.call(1);
    r.assistant(1, [{ type: "text", text: "Done again." }]);
    r.usage(1);
    r.finished();
    return { r, keptSeq };
  }

  it("names the first kept user message by its first 160 characters, without the sender line", () => {
    const text = `Now reconcile the savings account. ${"x".repeat(300)}`;
    const { r, keptSeq } = twoTurns("Check the cash account.", text);
    const out = built(r, { boundary: { mode: "marked", firstKeptSeq: keptSeq } });
    const anchor = text.slice(0, 160);
    const instruction = inContextInstruction(anchor);
    expect(out.request.messages.at(-1)).toEqual({
      role: "user",
      content: [{ type: "text", text: instruction }],
    });
    expect(instruction).toContain(`«${anchor}»`);
    expect(instruction).not.toContain(`«${text.slice(0, 161)}`);
    expect(instruction).not.toContain("From Ada");
  });

  it("skips when the kept message's prefix also starts an earlier user message", () => {
    const { r, keptSeq } = twoTurns("Please continue.", "Please continue.");
    expect(build(r, { boundary: { mode: "marked", firstKeptSeq: keptSeq } })).toEqual({
      skip: "boundary_ambiguous",
    });
  });

  it("a later message with the same prefix does not make the mark ambiguous", () => {
    const { r } = twoTurns("Please continue.", "Please continue.");
    const firstSeq = Math.min(
      ...r.events.filter((e) => e.type === "user_message").map((e) => e.seq),
    );
    const out = built(r, { boundary: { mode: "marked", firstKeptSeq: firstSeq } });
    expect(out.request.messages.at(-1)?.content).toEqual([
      { type: "text", text: inContextInstruction("Please continue.") },
    ]);
  });

  it("skips a mark that is not a user message in the request", () => {
    const { r } = twoTurns("Check the cash account.", "Now the savings.");
    const assistantSeq = r.events.find((e) => e.type === "assistant_message")?.seq ?? 0;
    expect(build(r, { boundary: { mode: "marked", firstKeptSeq: assistantSeq } })).toEqual({
      skip: "boundary_ambiguous",
    });
  });
});

describe("inContextInstruction", () => {
  it("opens with the stop line and keeps every summary task line verbatim", () => {
    for (const anchor of [null, "Now reconcile the savings account."]) {
      const text = inContextInstruction(anchor);
      expect(
        text.startsWith(
          "Stop the task. Do not call tools. Write a summary of the conversation above so the agent can continue without the full history.",
        ),
      ).toBe(true);
      for (const line of SUMMARY_TASK_LINES) expect(text).toContain(line);
      // the transcript's own reading rules are not the in-context ones
      for (const line of TRANSCRIPT_READING_LINES) expect(text).not.toContain(line);
    }
  });

  it("states the in-context reading rules and origins", () => {
    const text = inContextInstruction(null);
    expect(text).toContain("Only user-role messages written by the conversation's people");
    for (const origin of [
      '"[Scheduled task',
      "the agent that dispatched it",
      "<skill_invocation>",
      '"Report from the sub-agent that ran the skill',
      "platform notices",
      'starts with "[system]"',
      "<conversation_summary>",
    ]) {
      expect(text).toContain(origin);
    }
  });

  it("scopes the summary to the whole conversation or to before the mark", () => {
    expect(inContextInstruction(null)).toContain("Summarize the whole conversation above.");
    const marked = inContextInstruction("Now the savings.");
    expect(marked).toContain(
      "Summarize only the part of the conversation before the user message that begins: «Now the savings.». That message and everything after it stay in the context verbatim: read them for context, but do not summarize them, and write section 8 about the work just before that message.",
    );
    expect(marked).not.toContain("Summarize the whole conversation above.");
  });

  it("the transcript instruction is built from the same shared lines", () => {
    const text = buildCompactionRequest("User: hi", "fake-1").system[0]?.text ?? "";
    for (const line of [...SUMMARY_TASK_LINES, ...TRANSCRIPT_READING_LINES]) {
      expect(text).toContain(line);
    }
  });
});

describe("inContextSummaryAllowed (the quality gate, idle compaction spec §9.4)", () => {
  it("allows a model the table lists for its provider", () => {
    expect(inContextSummaryAllowed("model-fake", "fake-1")).toBe(true);
    expect(inContextSummaryAllowed("model-fake", "fake-small")).toBe(true);
  });

  it("refuses the same model id under another provider", () => {
    expect(inContextSummaryAllowed("model-fake-2", "fake-1")).toBe(false);
    expect(inContextSummaryAllowed("stub", "fake-1")).toBe(false);
  });

  it("refuses a model no entry names (the default is the transcript)", () => {
    expect(inContextSummaryAllowed("anthropic", "claude-unknown-9")).toBe(false);
  });

  it("an entry without a provider matches the model id under any provider", () => {
    const table = [{ model: /^family-a-/, evidence: "test" }];
    expect(inContextSummaryAllowed("one", "family-a-mini", table)).toBe(true);
    expect(inContextSummaryAllowed("two", "family-a-max", table)).toBe(true);
    expect(inContextSummaryAllowed("two", "family-b-max", table)).toBe(false);
  });

  it("allows claude-sonnet-* and deepseek-* by model id under any provider", () => {
    for (const provider of ["anthropic", "openai-compatible", "bedrock"]) {
      expect(inContextSummaryAllowed(provider, "claude-sonnet-5-5")).toBe(true);
      expect(inContextSummaryAllowed(provider, "deepseek-flash")).toBe(true);
      expect(inContextSummaryAllowed(provider, "deepseek-v4")).toBe(true);
    }
  });

  it("refuses the models whose in-context summaries failed or were not measured", () => {
    for (const model of ["claude-haiku-5-5", "gpt-5-nano", "qwen3.8-flash", "my-claude-sonnet"]) {
      expect(inContextSummaryAllowed("anthropic", model)).toBe(false);
      expect(inContextSummaryAllowed("openai-compatible", model)).toBe(false);
    }
  });

  it("every entry carries its evidence", () => {
    for (const entry of IN_CONTEXT_SUMMARY_MODELS) expect(entry.evidence.length).toBeGreaterThan(0);
  });
});

describe("inContextCoversUpToSeq (boundary mode all)", () => {
  const ev = (seq: number, type: string, payload: unknown = {}): ConversationEvent =>
    ({ seq, type, payload, runId: RUN, conversationId: CONV, createdAt: new Date(AT) }) as never;
  const user = (seq: number) =>
    ev(seq, "user_message", { content: [{ type: "text", text: "hi" }], authorAccountId: "a" });

  it("covers every event when everything is absorbed", () => {
    const events = [user(1), ev(2, "model_call"), ev(3, "assistant_message"), ev(4, "usage")];
    expect(inContextCoversUpToSeq(events, 1)).toBe(4);
  });

  it("stops before the first message the next request does not absorb", () => {
    const events = [user(1), ev(2, "model_call"), user(3), ev(4, "tool_result"), user(5)];
    expect(inContextCoversUpToSeq(events, 1)).toBe(2);
    expect(inContextCoversUpToSeq(events, 3)).toBe(4);
    expect(inContextCoversUpToSeq(events, 5)).toBe(5);
  });

  it("reads the events in seq order", () => {
    expect(inContextCoversUpToSeq([user(3), ev(1, "run_started"), ev(2, "model_call")], 2)).toBe(2);
  });
});

describe("unansweredAfterReply (ruling R9: the in-context path runs only at a settled point)", () => {
  const ev = (seq: number, type: string, payload: unknown = {}): ConversationEvent =>
    ({ seq, type, payload, runId: RUN, conversationId: CONV, createdAt: new Date(AT) }) as never;
  const user = (seq: number) =>
    ev(seq, "user_message", { content: [{ type: "text", text: "hi" }], authorAccountId: "a" });
  const result = (seq: number) =>
    ev(seq, "tool_result", {
      step: 1,
      callId: "c1",
      toolKey: "Read",
      content: "x",
      isError: false,
    });
  const settled = { coversUpToSeq: 100, absorbedUpToSeq: 100, openers: [] as number[] };

  it("nothing after the reference reply: settled", () => {
    const events = [user(1), ev(2, "model_call"), ev(3, "assistant_message"), ev(4, "usage")];
    expect(unansweredAfterReply(events, settled)).toBe(false);
  });

  it("a tool result after the reference reply is unanswered", () => {
    const events = [user(1), ev(2, "model_call"), ev(3, "assistant_message"), result(4)];
    expect(unansweredAfterReply(events, settled)).toBe(true);
  });

  it("an absorbed message or interjection after the reference reply is unanswered", () => {
    const base = [user(1), ev(2, "model_call"), ev(3, "assistant_message")];
    expect(unansweredAfterReply([...base, user(4)], settled)).toBe(true);
    expect(unansweredAfterReply([...base, ev(4, "background_task_finished")], settled)).toBe(true);
    expect(unansweredAfterReply([...base, ev(4, "subagent_delivery")], settled)).toBe(true);
  });

  it("ruling R9a: a run opener the summary re-renders verbatim does not count", () => {
    const events = [user(1), ev(2, "model_call"), ev(3, "assistant_message"), user(4), user(5)];
    expect(unansweredAfterReply(events, { ...settled, openers: [4, 5] })).toBe(false);
    expect(unansweredAfterReply(events, { ...settled, openers: [4] })).toBe(true);
  });

  it("only what the summary covers counts: a later or unabsorbed message stays in the tail", () => {
    const events = [user(1), ev(2, "model_call"), ev(3, "assistant_message"), user(4), result(5)];
    expect(unansweredAfterReply(events, { ...settled, coversUpToSeq: 3 })).toBe(false);
    expect(unansweredAfterReply(events.slice(0, 4), { ...settled, absorbedUpToSeq: 3 })).toBe(
      false,
    );
  });

  it("what came before the reference reply does not count", () => {
    const events = [user(1), result(2), ev(3, "model_call"), ev(4, "assistant_message")];
    expect(unansweredAfterReply(events, settled)).toBe(false);
  });

  it("a reference call without a reply: everything after the call counts", () => {
    expect(unansweredAfterReply([user(1), ev(2, "model_call"), result(3)], settled)).toBe(true);
  });
});
