import type { ModelInfo, ModelRequest, ParamValue } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import type { AgentDefinition } from "../../src/agents/definition.js";
import {
  buildSuggestionRequest,
  cleanSuggestion,
  lastModelCallOf,
  PROMPT_SUGGESTION_INSTRUCTION,
  PROMPT_SUGGESTION_MAX_CHARS,
  PROMPT_SUGGESTION_MAX_DELAY_MS,
  PROMPT_SUGGESTION_MAX_OUTPUT_TOKENS,
  PROMPT_SUGGESTION_UNCACHED_INPUT_MAX,
  type SuggestionEligibilityInput,
  suggestionEligible,
  suggestionStale,
} from "../../src/conversations/prompt-suggestion-request.js";
import { reconstructRequest } from "../../src/evals/reconstruct.js";
import { type CaseSnapshot, toEvents } from "../../src/evals/snapshot.js";
import type { RequestTool } from "../../src/runtime/context/build.js";
import { assembleModelRequest, WRAP_UP_REMINDER } from "../../src/runtime/model-call.js";

/**
 * Prompt suggestions spec §1–§2: the side request is the run's last request rebuilt through the
 * zero-drift path plus the final reply and the instruction; eligibility, cleaning and staleness.
 * Pure: the logs are built in memory the way the runtime records them.
 */

const ORG = "00000000-0000-4000-8000-000000000001";
const CONV = "00000000-0000-4000-8000-000000000002";
const RUN = "00000000-0000-4000-8000-000000000003";
const AT = "2026-11-19T00:00:00.000Z";

const MODEL: ModelInfo = {
  id: "fake-1",
  displayName: "Fake 1",
  contextWindow: 200_000,
  maxOutputTokens: 8192,
  capabilities: {
    tools: true,
    vision: false,
    reasoning: true,
    caching: true,
    midConversationSystem: true,
  },
  parameters: [],
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

const TOOL_SEARCH: RequestTool = {
  key: "ToolSearch",
  specHash: "hash-tool-search",
  spec: {
    name: "ToolSearch",
    description: "Load tools by query.",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
  },
};

const LEDGER: RequestTool = {
  key: "Ledger",
  specHash: "hash-ledger",
  spec: {
    name: "Ledger",
    description: "Read ledger entries.",
    inputSchema: { type: "object", properties: {} },
  },
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

/** The runtime's default output cap when the agent sets no `maxOutputTokens` knob. */
const DEFAULT_CAP = 4096;

/** Builds a run's log as the runtime records it: each `model_call` carries what was sent. */
class Recorder {
  readonly events: CaseSnapshot["events"] = [];

  constructor(
    readonly runId = RUN,
    readonly tools: RequestTool[] = [LOOKUP],
    readonly setup: { model?: ModelInfo; agent?: AgentDefinition; toolSearch?: boolean } = {},
  ) {}

  add(type: string, payload: unknown, runId: string | null = this.runId): number {
    const seq = (this.events.at(-1)?.seq ?? 0) + 1;
    this.events.push({ seq, type, payload, runId, createdAt: AT } as CaseSnapshot["events"][0]);
    return seq;
  }

  user(text: string): number {
    return this.add(
      "user_message",
      { content: [{ type: "text", text }], authorAccountId: "acc-1" },
      null,
    );
  }

  started(trigger?: string): number {
    return this.add("run_started", {
      agentVersion: 1,
      model: { provider: "model-fake", model: "fake-1" },
      triggerAccountId: "acc-1",
      ...(trigger !== undefined && { trigger }),
    });
  }

  /** A model call built from the log so far, recorded with the meta the request carried. */
  call(
    step: number,
    opts: {
      toolChoice?: "none";
      maxOutputTokens?: number;
      fit?: unknown;
      params?: Record<string, ParamValue>;
      /** The cap as the hard fit guard clamped it (recorded instead of the computed one). */
      clampedCap?: number;
    } = {},
  ): number {
    const events = toEvents(this.snapshot());
    const absorbed = Math.max(
      0,
      ...events.filter((e) => e.type === "user_message").map((e) => e.seq),
    );
    const { request, meta } = assembleModelRequest({
      events,
      agent: this.setup.agent ?? AGENT,
      agentVersion: 1,
      model: this.setup.model ?? MODEL,
      step,
      absorbedUpToSeq: absorbed,
      params: opts.params ?? {},
      tools: this.tools,
      toolSearch: this.setup.toolSearch ?? false,
      ...(opts.toolChoice !== undefined && { toolChoice: opts.toolChoice }),
      defaultMaxOutputTokens: opts.maxOutputTokens ?? DEFAULT_CAP,
    });
    return this.add("model_call", {
      step,
      attempt: 1,
      provider: "model-fake",
      model: "fake-1",
      fallback: false,
      request: {
        ...meta,
        maxOutputTokens: opts.clampedCap ?? request.maxOutputTokens,
        ...(opts.fit !== undefined && { fit: opts.fit }),
      },
    });
  }

  assistant(step: number, content: unknown[], stopReason = "end_turn"): number {
    return this.add("assistant_message", { step, content, stopReason });
  }

  toolCall(step: number, id: string, text = "Let me check."): number {
    return this.assistant(
      step,
      [
        { type: "text", text },
        { type: "tool_call", id, name: "Lookup", input: { account: "cash" } },
      ],
      "tool_use",
    );
  }

  toolResult(step: number, callId: string, content: string): number {
    return this.add("tool_result", { step, callId, toolKey: "Lookup", content, isError: false });
  }

  usage(
    step: number,
    tokens: { input?: number; cacheRead?: number; cacheWrite?: number } = {},
    purpose?: string,
    runId: string | null = this.runId,
  ): number {
    return this.add(
      "usage",
      {
        step,
        provider: "model-fake",
        model: "fake-1",
        inputTokens: tokens.input ?? 100,
        outputTokens: 10,
        cacheReadTokens: tokens.cacheRead ?? 90,
        cacheWriteTokens: tokens.cacheWrite ?? 0,
        ...(purpose !== undefined && { purpose }),
      },
      runId,
    );
  }

  finished(reason = "completed"): number {
    return this.add("run_finished", {
      reason,
      consumedUpToSeq: this.events.at(-1)?.seq ?? 0,
    });
  }

  snapshot(): CaseSnapshot {
    return {
      version: 1,
      orgId: ORG,
      conversationId: CONV,
      runId: this.runId,
      agentId: ORG,
      agentVersion: 1,
      source: "web",
      events: structuredClone(this.events),
      definitions: { "1": this.setup.agent ?? AGENT },
      toolSpecs: Object.fromEntries(this.tools.map((t) => [t.specHash, t.spec])),
    };
  }
}

/** A finished two-step run: a tool call, its result, then the final text. */
function twoStepRun(final: unknown[] = [{ type: "text", text: "Cash is 120 EUR." }]): Recorder {
  const r = new Recorder();
  r.user("What is my cash balance?");
  r.started();
  r.call(1);
  r.toolCall(1, "call-1");
  r.usage(1);
  r.toolResult(1, "call-1", "120 EUR");
  r.call(2);
  r.assistant(2, final);
  r.usage(2);
  r.finished();
  return r;
}

const build = (snapshot: CaseSnapshot, model: ModelInfo = MODEL, reserveTokens = 0) =>
  buildSuggestionRequest({ snapshot, model, reserveTokens });

function built(snapshot: CaseSnapshot, model: ModelInfo = MODEL) {
  const out = build(snapshot, model);
  if ("skip" in out) throw new Error(`skipped: ${out.skip}`);
  return out;
}

function reference(snapshot: CaseSnapshot, model: ModelInfo = MODEL) {
  const call = lastModelCallOf(toEvents(snapshot), snapshot.runId);
  if (!call) throw new Error("no model_call");
  const ref = reconstructRequest(snapshot, call.seq, { model });
  expect(ref.drift).toEqual([]);
  return ref.request;
}

function expectSidePrefix(side: ModelRequest, ref: ModelRequest) {
  expect(side.system).toEqual(ref.system);
  expect(side.tools).toEqual(ref.tools);
  expect(side.params).toEqual(ref.params);
  expect(side.toolChoice).toEqual(ref.toolChoice);
  expect("toolChoice" in side).toBe("toolChoice" in ref);
  expect(side.model).toBe(ref.model);
  expect(side.messages.slice(0, ref.messages.length)).toEqual(ref.messages);
}

describe("buildSuggestionRequest", () => {
  it("equals the last request plus two messages", () => {
    const snap = twoStepRun().snapshot();
    const ref = reference(snap);
    const out = built(snap);
    expectSidePrefix(out.request, ref);
    expect(out.request.messages.slice(ref.messages.length)).toEqual([
      { role: "assistant", content: [{ type: "text", text: "Cash is 120 EUR." }] },
      { role: "user", content: [{ type: "text", text: PROMPT_SUGGESTION_INSTRUCTION }] },
    ]);
    expect(ref.maxOutputTokens).toBe(DEFAULT_CAP);
    expect(out.request.maxOutputTokens).toBe(PROMPT_SUGGESTION_MAX_OUTPUT_TOKENS);
    expect(out.request.purpose).toBe("suggestion");
    expect(ref.purpose).toBeUndefined();
    // nothing else differs
    const { messages: _m, maxOutputTokens: _o, purpose: _p, ...restSide } = out.request;
    const { messages: _rm, maxOutputTokens: _ro, purpose: _rp, ...restRef } = ref;
    expect(restSide).toEqual(restRef);
    const call = lastModelCallOf(toEvents(snap), RUN);
    expect(out.lastCall).toEqual({ seq: call?.seq, provider: "model-fake", model: "fake-1" });
    expect(out.finalText).toBe("Cash is 120 EUR.");
    expect(out.estimate).toBeGreaterThan(0);
  });

  it("carries the recorded params, catalog, loaded tool and clamped cap, and the reply's opaque blocks", () => {
    const model: ModelInfo = {
      ...MODEL,
      parameters: [
        {
          key: "effort",
          standard: "effort",
          schema: { type: "string", enum: ["low", "medium", "high"] },
          label: { zh: "effort", en: "Effort" },
        },
        {
          key: "maxOutputTokens",
          standard: "maxOutputTokens",
          schema: { type: "integer", minimum: 1, maximum: 8192 },
          label: { zh: "max", en: "Max output" },
        },
      ],
    };
    // the agent's saved knobs differ from what the call recorded: the side request must follow
    // the record, never the definition
    const agent: AgentDefinition = {
      ...AGENT,
      modelParams: { effort: "low", maxOutputTokens: 7000 },
    };
    const recorded = { effort: "high", maxOutputTokens: 6000 };
    const r = new Recorder(RUN, [TOOL_SEARCH, LOOKUP, LEDGER], { model, agent, toolSearch: true });
    r.user("What is my cash balance?");
    r.started();
    r.call(1, { params: recorded, clampedCap: 1500 });
    r.assistant(
      1,
      [{ type: "tool_call", id: "call-1", name: "ToolSearch", input: { query: "balance" } }],
      "tool_use",
    );
    r.usage(1);
    r.add("tool_result", {
      step: 1,
      callId: "call-1",
      toolKey: "ToolSearch",
      content: "Loaded Lookup.",
      isError: false,
      loadedTools: ["Lookup"],
    });
    r.call(2, { params: recorded, clampedCap: 1500 });
    r.toolCall(2, "call-2");
    r.usage(2);
    r.toolResult(2, "call-2", "120 EUR");
    r.call(3, { params: recorded, clampedCap: 1500 });
    const opaque = {
      provider: "model-fake",
      model: "fake-1",
      data: { signature: "sig-1", n: [1] },
    };
    const finalBlocks = [
      { type: "thinking", text: "The balance is known.", opaque },
      { type: "text", text: "Cash is 120 EUR.", opaque: { ...opaque, data: { id: "msg-1" } } },
    ];
    r.assistant(3, finalBlocks);
    r.usage(3);
    r.finished();
    const snap = r.snapshot();
    const ref = reference(snap, model);
    expect(ref.tools.map((t) => t.name)).toEqual(["ToolSearch", "Lookup"]);
    expect(ref.system).toHaveLength(2);
    expect(ref.system[1]?.text).toContain("Ledger");
    const out = built(snap, model);
    expectSidePrefix(out.request, ref);
    expect(out.request.params).toEqual(recorded);
    expect(out.request.tools.map((t) => t.name)).toEqual(["ToolSearch", "Lookup"]);
    expect(out.request.maxOutputTokens).toBe(1500);
    expect(out.request.messages[ref.messages.length]).toEqual({
      role: "assistant",
      content: finalBlocks,
    });
  });

  it("skips when the resolved model is not the last call's model", () => {
    const snap = twoStepRun().snapshot();
    expect(build(snap, { ...MODEL, id: "fake-2" })).toEqual({ skip: "model_mismatch" });
  });

  it("keeps a recorded cap below 2048", () => {
    const r = new Recorder();
    r.user("hi");
    r.started();
    r.call(1, { maxOutputTokens: 1000 });
    r.assistant(1, [{ type: "text", text: "Hello." }]);
    r.usage(1);
    r.finished();
    expect(built(r.snapshot()).request.maxOutputTokens).toBe(1000);
  });

  it("toolChoice stays absent on an ordinary run", () => {
    const out = built(twoStepRun().snapshot());
    expect("toolChoice" in out.request).toBe(false);
  });

  it("keeps toolChoice none after a wrap-up", () => {
    const r = new Recorder();
    r.user("Check every account.");
    r.started();
    r.call(1);
    r.toolCall(1, "call-1");
    r.usage(1);
    r.toolResult(1, "call-1", "120 EUR");
    r.add("reminder", { step: 2, text: WRAP_UP_REMINDER });
    r.call(2, { toolChoice: "none" });
    r.assistant(2, [{ type: "text", text: "Checked cash; savings remain." }]);
    r.usage(2);
    r.finished("max_steps");
    const snap = r.snapshot();
    const ref = reference(snap);
    expect(ref.toolChoice).toBe("none");
    expect(ref.messages.at(-1)).toEqual({ role: "system", content: WRAP_UP_REMINDER });
    const out = built(snap);
    expect(out.request.toolChoice).toBe("none");
    expectSidePrefix(out.request, ref);
    expect(out.request.messages).toHaveLength(ref.messages.length + 2);
  });

  it("works on a later run of the conversation", () => {
    const first = twoStepRun();
    const r = new Recorder("00000000-0000-4000-8000-000000000004");
    r.events.push(...first.events);
    r.user("And my savings?");
    r.started();
    r.call(1);
    r.assistant(1, [{ type: "text", text: "Savings are 900 EUR." }]);
    r.usage(1);
    r.finished();
    const snap = r.snapshot();
    const out = built(snap);
    expectSidePrefix(out.request, reference(snap));
    expect(out.finalText).toBe("Savings are 900 EUR.");
    // the run's side request rendered the final reply exactly as the next run's first call did
    const firstSide = built(first.snapshot());
    const n = reference(first.snapshot()).messages.length;
    const nextCall = toEvents(snap).find((e) => e.type === "model_call" && e.runId === r.runId);
    if (!nextCall) throw new Error("no model_call");
    const next = reconstructRequest(snap, nextCall.seq, { model: MODEL });
    expect(next.drift).toEqual([]);
    expect(next.request.messages.slice(0, n + 1)).toEqual(
      firstSide.request.messages.slice(0, n + 1),
    );
  });

  it("skips without a model call", () => {
    const r = new Recorder();
    r.user("hi");
    r.started();
    r.finished();
    expect(build(r.snapshot())).toEqual({ skip: "no_model_call" });
  });

  it("skips on drift", () => {
    const snap = twoStepRun().snapshot();
    snap.definitions["1"] = { ...AGENT, instructions: "Changed." };
    expect(build(snap)).toEqual({ skip: "drift" });
  });

  it("skips on a fit plan", () => {
    const r = new Recorder();
    r.user("hi");
    r.started();
    r.call(1, { fit: { droppedMessageIndexes: [], truncated: [] } });
    r.assistant(1, [{ type: "text", text: "Hello." }]);
    r.usage(1);
    r.finished();
    expect(build(r.snapshot())).toEqual({ skip: "fit" });
  });

  it("skips on a final tool call", () => {
    const r = new Recorder();
    r.user("hi");
    r.started();
    r.call(1);
    r.toolCall(1, "call-1");
    r.usage(1);
    r.finished("max_steps");
    expect(build(r.snapshot())).toEqual({ skip: "final_reply_has_tool_call" });
  });

  it("skips without a final reply or without text", () => {
    const none = new Recorder();
    none.user("hi");
    none.started();
    none.call(1);
    none.finished();
    expect(build(none.snapshot())).toEqual({ skip: "no_final_reply" });
    const thinking = twoStepRun([{ type: "thinking", text: "nothing to say" }]);
    expect(build(thinking.snapshot())).toEqual({ skip: "no_final_reply" });
    const blank = twoStepRun([{ type: "text", text: "  " }]);
    expect(build(blank.snapshot())).toEqual({ skip: "no_final_reply" });
  });

  it("skips on a prefix mismatch", () => {
    // a reminder logged after the final reply's call was built (an event the recorded request
    // never saw) lands between the prefix and the final reply
    const r = new Recorder();
    r.user("hi");
    r.started();
    r.call(1);
    r.add("reminder", { step: 1, text: "Late reminder." });
    r.assistant(1, [{ type: "text", text: "Hello." }]);
    r.usage(1);
    r.finished();
    const snap = r.snapshot();
    reference(snap);
    expect(build(snap)).toEqual({ skip: "prefix_mismatch" });
  });

  it("skips when a model-visible event follows the final reply", () => {
    const r = new Recorder();
    r.user("hi");
    r.started();
    r.call(1);
    r.assistant(1, [{ type: "text", text: "Hello." }]);
    r.usage(1);
    r.add("reminder", { step: 1, text: "Late reminder." });
    r.finished();
    expect(build(r.snapshot())).toEqual({ skip: "prefix_mismatch" });
  });

  it("a message logged after the final reply stays out (not absorbed)", () => {
    const plain = new Recorder();
    plain.user("hi");
    plain.started();
    plain.call(1);
    plain.assistant(1, [{ type: "text", text: "Hello." }]);
    plain.usage(1);
    const late = new Recorder();
    late.events.push(...structuredClone(plain.events));
    late.user("one more thing");
    late.finished();
    plain.finished();
    expect(built(late.snapshot()).request).toEqual(built(plain.snapshot()).request);
  });

  it("skips a snapshot with a corrupt permission context instead of throwing", () => {
    const snap = twoStepRun().snapshot();
    snap.events.splice(1, 0, {
      seq: 1.5,
      type: "permission_context",
      payload: { version: 1, broken: true },
      runId: RUN,
      createdAt: AT,
    });
    expect(build(snap)).toEqual({ skip: "drift" });
  });

  it("skips uncached large input", () => {
    const at = (input: number, cacheRead: number, cacheWrite: number) => {
      const r = new Recorder();
      r.user("hi");
      r.started();
      r.call(1);
      r.assistant(1, [{ type: "text", text: "Hello." }]);
      r.usage(1, { input, cacheRead, cacheWrite });
      // a later purposed usage (a title) is not the step's
      r.usage(0, { input: 10, cacheRead: 5 }, "title", null);
      r.finished();
      return build(r.snapshot());
    };
    const big = PROMPT_SUGGESTION_UNCACHED_INPUT_MAX + 1;
    expect(at(big, 0, 0)).toEqual({ skip: "uncached" });
    expect("request" in at(PROMPT_SUGGESTION_UNCACHED_INPUT_MAX, 0, 0)).toBe(true);
    expect("request" in at(big, 1, 0)).toBe(true);
    expect("request" in at(big, 0, 1)).toBe(true);
  });

  it("skips too large", () => {
    const snap = twoStepRun().snapshot();
    const { estimate } = built(snap);
    const fits = { ...MODEL, contextWindow: estimate + PROMPT_SUGGESTION_MAX_OUTPUT_TOKENS + 500 };
    expect("request" in build(snap, fits, 500)).toBe(true);
    expect(build(snap, fits, 501)).toEqual({ skip: "too_large" });
  });
});

describe("lastModelCallOf", () => {
  it("takes the run's call with the highest seq", () => {
    const first = twoStepRun();
    const events = toEvents(first.snapshot());
    const calls = events.filter((e) => e.type === "model_call");
    expect(lastModelCallOf(events, RUN)?.seq).toBe(calls.at(-1)?.seq);
    expect(lastModelCallOf(events, "other-run")).toBeUndefined();
  });
});

describe("suggestionEligible", () => {
  const ok: SuggestionEligibilityInput = {
    outcome: "completed",
    kind: "chat",
    source: "web",
    trigger: undefined,
  };

  it("a completed or max_steps web chat run started by a message or a wake qualifies", () => {
    expect(suggestionEligible(ok)).toBe(true);
    expect(suggestionEligible({ ...ok, outcome: "max_steps" })).toBe(true);
    expect(suggestionEligible({ ...ok, trigger: "message" })).toBe(true);
    expect(suggestionEligible({ ...ok, trigger: "background_task" })).toBe(true);
    expect(suggestionEligible({ ...ok, trigger: "subagent" })).toBe(true);
  });

  it("the outcome row", () => {
    expect(suggestionEligible({ ...ok, outcome: "max_duration" })).toBe(false);
    expect(suggestionEligible({ ...ok, outcome: "budget" })).toBe(false);
  });

  it("the kind row", () => {
    expect(suggestionEligible({ ...ok, kind: "eval" })).toBe(false);
    expect(suggestionEligible({ ...ok, kind: "subagent" })).toBe(false);
  });

  it("the source row", () => {
    expect(suggestionEligible({ ...ok, source: "channel_dm" })).toBe(false);
    expect(suggestionEligible({ ...ok, source: "channel_group" })).toBe(false);
    expect(suggestionEligible({ ...ok, source: "subagent" })).toBe(false);
  });

  it("the trigger row", () => {
    expect(suggestionEligible({ ...ok, trigger: "schedule" })).toBe(false);
    expect(suggestionEligible({ ...ok, trigger: "compact" })).toBe(false);
  });
});

describe("cleanSuggestion", () => {
  const final = "Cash is 120 EUR.";

  it("NONE in any case or empty means no suggestion", () => {
    expect(cleanSuggestion("NONE", final)).toBeNull();
    expect(cleanSuggestion(" none ", final)).toBeNull();
    expect(cleanSuggestion("None.", final)).toBeNull();
    expect(cleanSuggestion("", final)).toBeNull();
    expect(cleanSuggestion(" \n\t\n", final)).toBeNull();
    expect(cleanSuggestion('""', final)).toBeNull();
  });

  it("strips wrapping quotes and a user label", () => {
    expect(cleanSuggestion('"Show savings too"', final)).toBe("Show savings too");
    expect(cleanSuggestion("“Show savings too”", final)).toBe("Show savings too");
    expect(cleanSuggestion("'Show savings too'", final)).toBe("Show savings too");
    expect(cleanSuggestion("「看看储蓄」", final)).toBe("看看储蓄");
    expect(cleanSuggestion("User: Show savings too", final)).toBe("Show savings too");
    expect(cleanSuggestion('user: "Show savings too"', final)).toBe("Show savings too");
    expect(cleanSuggestion("用户：看看储蓄", final)).toBe("看看储蓄");
    expect(cleanSuggestion("用户: 看看储蓄", final)).toBe("看看储蓄");
    // a quote inside the text stays, and two quotations are not one wrapped text
    expect(cleanSuggestion('"a" and "b"', final)).toBe('"a" and "b"');
    expect(cleanSuggestion("“yes” or “no”", final)).toBe("“yes” or “no”");
    expect(cleanSuggestion('Rename it to "cash"', final)).toBe('Rename it to "cash"');
  });

  it("removes control and bidi characters", () => {
    expect(cleanSuggestion("Show\u0007 savings\u202e too\u200b", final)).toBe("Show savings too");
    expect(cleanSuggestion("\u2066Show savings\u2069", final)).toBe("Show savings");
    expect(cleanSuggestion("Go\tahead", final)).toBe("Go ahead");
  });

  it("takes the first non-empty line", () => {
    expect(cleanSuggestion("\n\n  Show savings too\nand more\n", final)).toBe("Show savings too");
    expect(cleanSuggestion("\u200b\nSecond line", final)).toBe("Second line");
  });

  it("cuts at 200 characters on a code point boundary", () => {
    const long = `${"a".repeat(PROMPT_SUGGESTION_MAX_CHARS - 1)}😀😀tail`;
    const out = cleanSuggestion(long, final) as string;
    expect(Array.from(out)).toHaveLength(PROMPT_SUGGESTION_MAX_CHARS);
    expect(out.endsWith("😀")).toBe(true);
    expect(out).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
    expect(cleanSuggestion("short", final)).toBe("short");
  });

  it("an echo of the final reply means no suggestion", () => {
    expect(cleanSuggestion(final, final)).toBeNull();
    expect(cleanSuggestion(`"${final}"`, ` ${final}\n`)).toBeNull();
    expect(cleanSuggestion("Show savings too", final)).toBe("Show savings too");
  });
});

describe("suggestionStale", () => {
  it("is stale only past the maximum delay", () => {
    const t = 1_000_000;
    expect(suggestionStale(t, t)).toBe(false);
    expect(suggestionStale(t, t + PROMPT_SUGGESTION_MAX_DELAY_MS)).toBe(false);
    expect(suggestionStale(t, t + PROMPT_SUGGESTION_MAX_DELAY_MS + 1)).toBe(true);
  });
});
