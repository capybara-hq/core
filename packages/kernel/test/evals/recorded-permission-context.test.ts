import type { ModelInfo } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { AgentDefinitionSchema } from "../../src/agents/definition.js";
import type { AppendEvent } from "../../src/conversations/event-log.js";
import {
  type ConversationEvent,
  ConversationEventSchema,
  type PermissionContextV1,
} from "../../src/conversations/events.js";
import { ApiError } from "../../src/errors.js";
import {
  permissionFeedPlan,
  recordedPermissionContext,
  recordedRunPermissionDrift,
  replayPermissionContextIdemKey,
  selectOriginalRequest,
} from "../../src/evals/recorded-permission-context.js";
import {
  REPLAY_NO_RECORDING,
  RecordedToolPipeline,
  recordedCalls,
} from "../../src/evals/recorded-tools.js";
import { type CaseSnapshot, toEvents } from "../../src/evals/snapshot.js";
import { replayLoopDeps } from "../../src/evals/worker.js";
import { buildModelRequest } from "../../src/runtime/context/build.js";
import {
  permissionContextHistory,
  permissionContextText,
} from "../../src/runtime/context/permission-profile.js";
import type { LoopDeps } from "../../src/runtime/langgraph-loop.js";
import type { PermissionContextPort } from "../../src/runtime/model-call.js";

/**
 * Gate 9.5 (permission context replay spec B4): the recorded-only feeder of a full-run replay,
 * its sparse coordinate table, original-coordinate diagnostics, the structural strip of a live
 * recorder from the replay's loop deps, and old recordings untouched.
 */

const ROOT = "00000000-0000-4000-8000-000000000001";
const DEVICE = "00000000-0000-4000-8000-000000000002";
const RUN = "target-run";
const GEN = { conversationId: "generated-conversation", runId: "generated-run" };

/** A valid v1 snapshot, distinct per revision. */
const ctx = (revision: number): PermissionContextV1 => ({
  version: 1,
  rootConversationId: ROOT,
  profileRevision: revision,
  selectedProfile: "request-approval",
  effectiveProfile: "request-approval",
  execution: "interactive",
  inherited: false,
  deviceId: DEVICE,
  scopeRevision: `scope-${revision}`,
  authorityRevision: `authority-${revision}`,
  availability: { state: "supported" },
  scope: {
    location: "local",
    workingRoot: `/project-${revision}`,
    filesystem: {
      kind: "scoped",
      readDirectories: [`/project-${revision}`],
      writeDirectories: [`/project-${revision}`],
    },
    network: { kind: "none" },
    outerNetwork: { kind: "host-environment" },
  },
});

type Entry =
  | { type: string; payload: unknown; runId?: string | null }
  | { call: { step: number; attempt?: number; toSeq?: number }; runId?: string };

/**
 * A one-case snapshot built from `entries` (seq from 1); each `call` is a `model_call` of the
 * target run whose recorded permission metadata is what its own bounded range renders.
 */
function recording(entries: Entry[], runId = RUN): CaseSnapshot {
  const events: CaseSnapshot["events"] = [];
  for (const entry of entries) {
    const seq = events.length + 1;
    if ("call" in entry) {
      const upTo = Math.min(entry.call.toSeq ?? seq - 1, seq - 1);
      const meta = permissionContextHistory(
        toEvents({ ...base(runId), events }).filter((e) => e.seq <= upTo),
      ).meta;
      events.push({
        seq,
        type: "model_call",
        runId: entry.runId ?? runId,
        createdAt: "2026-11-16T00:00:00.000Z",
        payload: {
          step: entry.call.step,
          ...(entry.call.attempt !== undefined && { attempt: entry.call.attempt }),
          provider: "fake",
          model: "fake",
          fallback: false,
          request: {
            fromSeq: 1,
            toSeq: entry.call.toSeq ?? seq - 1,
            summarySeq: null,
            systemHash: "h",
            reminderSeqs: [],
            ...(meta !== undefined && { permissionContext: meta }),
          },
        },
      } as CaseSnapshot["events"][number]);
    } else {
      events.push({
        seq,
        type: entry.type,
        runId: entry.runId === undefined ? runId : entry.runId,
        payload: entry.payload,
        createdAt: "2026-11-16T00:00:00.000Z",
      } as CaseSnapshot["events"][number]);
    }
  }
  return { ...base(runId), events };
}
function base(runId: string): CaseSnapshot {
  return {
    version: 1,
    orgId: ROOT,
    conversationId: ROOT,
    runId,
    agentId: ROOT,
    agentVersion: 1,
    definitions: {},
    toolSpecs: {},
    events: [],
  };
}

const started = { type: "run_started", payload: { agentVersion: 1 } };
const user = (text: string) => ({
  type: "user_message",
  runId: null,
  payload: { content: [{ type: "text", text }] },
});
const permission = (revision: number, runId?: string | null) => ({
  type: "permission_context",
  payload: ctx(revision),
  ...(runId !== undefined && { runId }),
});

/** An in-memory event log with the real log's idempotency and write validation. */
class FakeLog {
  readonly events: ConversationEvent[];
  appendCalls = 0;
  constructor(seed: ConversationEvent[]) {
    this.events = [...seed];
  }
  async append(conversationId: string, batch: AppendEvent[]): Promise<ConversationEvent[]> {
    this.appendCalls++;
    expect(conversationId).toBe(GEN.conversationId);
    return batch.map((e) => {
      const hit = this.events.find(
        (x) => e.idemKey !== undefined && (x as { idemKey?: string }).idemKey === e.idemKey,
      );
      if (hit !== undefined) return hit;
      ConversationEventSchema.parse({ type: e.type, payload: e.payload });
      const event = {
        type: e.type,
        payload: e.payload,
        runId: e.runId ?? null,
        seq: Math.max(0, ...this.events.map((x) => x.seq)) + 1,
        conversationId,
        createdAt: new Date(),
        idemKey: e.idemKey,
      } as ConversationEvent & { idemKey?: string };
      this.events.push(event);
      return event;
    });
  }
  /** Permission contexts this log holds, as [seq, runId, profileRevision]. */
  contexts(): [number, string | null, number | null][] {
    return this.events.flatMap((e) =>
      e.type === "permission_context" ? [[e.seq, e.runId, e.payload.profileRevision]] : [],
    );
  }
}

/** What the seeder writes: the events before R at their seqs, then the generated run_started. */
function seeded(s: CaseSnapshot): FakeLog {
  const events = toEvents(s);
  const R = events.find((e) => e.type === "run_started" && e.runId === s.runId)?.seq ?? 0;
  return new FakeLog([
    ...events.filter((e) => e.seq < R),
    { ...(events.find((e) => e.seq === R) as ConversationEvent), runId: GEN.runId },
  ]);
}

function feeder(s: CaseSnapshot, log: FakeLog): PermissionContextPort {
  const f = recordedPermissionContext(s, log, GEN);
  if (f === undefined) throw new Error("Expected a recorded feeder");
  return f;
}
const at = (step: number, attempt = 1, signal = new AbortController().signal) => ({
  orgId: ROOT,
  accountId: "account",
  ...GEN,
  step,
  attempt,
  signal,
});

/**
 * The reference recording: an earlier run's context P (seed), the target run's A and B both
 * logged before its only step-1 request (a live fit before and after a compaction), C before
 * step 2, and D after the last request (never seen by the original run).
 */
const reference = () =>
  recording([
    { ...started, runId: "earlier-run" },
    permission(0, "earlier-run"),
    { call: { step: 1, attempt: 1 }, runId: "earlier-run" },
    user("Go"),
    started,
    permission(1),
    permission(2),
    { call: { step: 1, attempt: 1 } },
    { type: "assistant_message", payload: { step: 1, content: [], stopReason: "tool_use" } },
    permission(3),
    { call: { step: 2, attempt: 1 } },
    permission(4),
    { type: "assistant_message", payload: { step: 2, content: [], stopReason: "end_turn" } },
  ]);

describe("sparse coordinate table (spec B4)", () => {
  const req = (step: number, attempt: number, callSeq: number) => ({
    step,
    attempt,
    callSeq,
    upTo: callSeq - 1,
  });
  // steps 2 and 4 recorded; step 2 starts at attempt 2 and has a gap at attempt 3
  const requests = [req(2, 2, 10), req(2, 4, 11), req(4, 1, 20), req(4, 2, 21)];
  it.each<[string, number, number, number | undefined]>([
    ["a step before every original step: none, seeded history only", 1, 1, undefined],
    ["an attempt before the first recorded one: that first attempt", 2, 1, 0],
    ["the exact same-step attempt", 2, 2, 0],
    ["an interior same-step gap: the greatest earlier attempt", 2, 3, 0],
    ["the exact later attempt", 2, 4, 1],
    ["past the last attempt of the step: its last", 2, 9, 1],
    ["a step without requests: the last request of the greatest earlier step", 3, 1, 1],
    ["a later step's exact attempt", 4, 1, 2],
    ["past every original step: the final request", 7, 3, 3],
  ])("%s", (_name, step, attempt, expected) => {
    expect(selectOriginalRequest(requests, step, attempt)).toBe(expected);
  });
  it("a run without recorded requests selects nothing for any coordinate", () => {
    for (const [step, attempt] of [
      [1, 1],
      [3, 2],
    ] as const)
      expect(selectOriginalRequest([], step, attempt)).toBeUndefined();
  });
  it("plans original requests in callSeq order with U = min(toSeq, callSeq - 1) and a legacy attempt 1", () => {
    const s = recording([
      started,
      permission(1),
      { call: { step: 1 } },
      { call: { step: 2, attempt: 1, toSeq: 2 } },
      permission(2),
      { call: { step: 2, attempt: 2, toSeq: 99 } },
      permission(3),
    ]);
    const plan = permissionFeedPlan(toEvents(s), RUN, 1);
    expect(plan.requests).toEqual([
      { step: 1, attempt: 1, callSeq: 3, upTo: 2 },
      { step: 2, attempt: 1, callSeq: 4, upTo: 2 },
      { step: 2, attempt: 2, callSeq: 6, upTo: 5 },
    ]);
    // the context at 7 follows the last request: never fed
    expect(plan.contexts.map((c) => [c.seq, c.firstVisible])).toEqual([
      [2, 0],
      [5, 2],
    ]);
  });
  it.each<[string, Entry[]]>([
    [
      "a duplicate (step, attempt)",
      [started, { call: { step: 1, attempt: 1 } }, { call: { step: 1, attempt: 1 } }],
    ],
    [
      "an attempt going backwards",
      [started, { call: { step: 1, attempt: 2 } }, { call: { step: 1, attempt: 1 } }],
    ],
    [
      "a step going backwards",
      [started, { call: { step: 2, attempt: 1 } }, { call: { step: 1, attempt: 2 } }],
    ],
    [
      "a visibility bound going backwards",
      [started, permission(1), { call: { step: 1 } }, { call: { step: 2, toSeq: 1 } }],
    ],
  ])("rejects %s as an invalid v1 replay input", (_name, entries) => {
    const s = recording([...entries, permission(9)]);
    let thrown: unknown;
    try {
      recordedPermissionContext(s, seeded(s), GEN);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ApiError);
    expect(thrown).toMatchObject({ code: "eval.snapshot_invalid" });
  });
});

describe("recorded-only feeder (spec B4)", () => {
  it("a recording without markers installs no feeder at all", () => {
    const s = recording([
      user("Go"),
      started,
      { type: "device_paths", payload: { roots: { workspace: "/w", skills: "/s", tmp: "/t" } } },
      { call: { step: 1, attempt: 1 } },
    ]);
    expect(recordedPermissionContext(s, seeded(s), GEN)).toBeUndefined();
    expect(recordedRunPermissionDrift(s)).toBe(false);
  });

  it("feeds A then B at the only step-1 request, never C or D early, and keeps the seeded earlier context once", async () => {
    const s = reference();
    const log = seeded(s);
    const before = log.contexts();
    // the earlier run's P is seeded at its own seq and never appended again
    expect(before).toEqual([[2, "earlier-run", 0]]);
    const f = feeder(s, log);
    await f.beforeRequest(at(1));
    expect(log.contexts()).toEqual([...before, [6, GEN.runId, 1], [7, GEN.runId, 2]]);
    // the generated request renders the recorded content, located at the generated seqs
    const built = buildModelRequest({
      events: log.events,
      agent: AgentDefinitionSchema.parse({
        name: "a",
        instructions: "i",
        model: { provider: "fake", model: "fake" },
      }),
      agentVersion: 1,
      model: { id: "fake", contextWindow: 100_000 } as ModelInfo,
      step: 1,
      absorbedUpToSeq: 100,
    });
    expect(built.request.messages.filter((m) => m.role === "system").map((m) => m.content)).toEqual(
      [permissionContextText(ctx(0)), permissionContextText(ctx(1)), permissionContextText(ctx(2))],
    );
    expect(built.meta.permissionContext?.contextSeq).toBe(7);
    // a repeated construction at the same boundary (a rebuild after compaction) feeds nothing
    const appends = log.appendCalls;
    await f.beforeRequest(at(1));
    await f.beforeRequest(at(1, 2));
    expect(log.appendCalls).toBe(appends);
    expect(log.contexts()).toHaveLength(3);
    // step 2 makes C visible; D was never seen by the original run
    await f.beforeRequest(at(2));
    expect(log.contexts().map(([, , r]) => r)).toEqual([0, 1, 2, 3]);
    // extra generated steps keep the last recorded context: nothing new, never D
    await f.beforeRequest(at(3));
    await f.beforeRequest(at(9, 4));
    expect(log.contexts().map(([, , r]) => r)).toEqual([0, 1, 2, 3]);
    // payloads are copied exactly; only the run id is the generated one
    for (const e of log.events.filter((x) => x.type === "permission_context" && x.seq > 5))
      expect(e.payload).toEqual(ctx((e.payload as PermissionContextV1).profileRevision ?? -1));
  });

  it("a candidate ending after step 1 consumes no later context", async () => {
    const s = reference();
    const log = seeded(s);
    await feeder(s, log).beforeRequest(at(1));
    expect(log.contexts().map(([, , r]) => r)).toEqual([0, 1, 2]);
  });

  it("an original first attempt 2 supplies generated attempt 1 of that step", async () => {
    const s = recording([user("Go"), started, permission(1), { call: { step: 1, attempt: 2 } }]);
    const log = seeded(s);
    await feeder(s, log).beforeRequest(at(1, 1));
    expect(log.contexts().map(([, , r]) => r)).toEqual([1]);
  });

  it("an interior attempt gap uses the preceding same-step attempt, not the later one", async () => {
    const s = recording([
      user("Go"),
      started,
      permission(1),
      { call: { step: 1, attempt: 1 } },
      permission(2),
      { call: { step: 1, attempt: 3 } },
    ]);
    const log = seeded(s);
    const f = feeder(s, log);
    await f.beforeRequest(at(1, 1));
    await f.beforeRequest(at(1, 2));
    expect(log.contexts().map(([, , r]) => r)).toEqual([1]);
    await f.beforeRequest(at(1, 3));
    expect(log.contexts().map(([, , r]) => r)).toEqual([1, 2]);
  });

  it("a generated step the original never made uses the preceding step only, never a later one", async () => {
    const s = recording([
      user("Go"),
      started,
      permission(1),
      { call: { step: 1 } },
      permission(2),
      { call: { step: 3 } },
    ]);
    const log = seeded(s);
    const f = feeder(s, log);
    await f.beforeRequest(at(1));
    await f.beforeRequest(at(2));
    expect(log.contexts().map(([, , r]) => r)).toEqual([1]);
    await f.beforeRequest(at(3));
    expect(log.contexts().map(([, , r]) => r)).toEqual([1, 2]);
  });

  it("a generated step before every original step feeds nothing; seeded history stays", async () => {
    const s = recording([
      { ...started, runId: "earlier-run" },
      permission(0, "earlier-run"),
      user("Go"),
      started,
      permission(1),
      { call: { step: 2 } },
    ]);
    const log = seeded(s);
    await feeder(s, log).beforeRequest(at(1));
    expect(log.contexts()).toEqual([[2, "earlier-run", 0]]);
  });

  it("a marked recording without any agent request installs a feeder that never feeds", async () => {
    const s = recording([user("Go"), started, permission(1)]);
    const log = seeded(s);
    const f = feeder(s, log);
    for (const step of [1, 2, 5]) await f.beforeRequest(at(step));
    expect(log.contexts()).toEqual([]);
    expect(log.appendCalls).toBe(0);
  });

  it("recovers the original-to-generated mapping from the idempotency keys on reentry", async () => {
    const s = reference();
    const log = seeded(s);
    await feeder(s, log).beforeRequest(at(2));
    const first = log.contexts();
    // a fresh feeder (no in-memory state) on the same generated run writes nothing new
    await feeder(s, log).beforeRequest(at(2));
    expect(log.contexts()).toEqual(first);
    const keyed = log.events.filter(
      (e) => (e as { idemKey?: string }).idemKey?.startsWith("replay_permission_context:") === true,
    );
    expect(keyed.map((e) => (e as { idemKey?: string }).idemKey)).toEqual(
      [6, 7, 10].map((seq) => replayPermissionContextIdemKey(GEN.runId, seq)),
    );
  });

  it("writes only to the generated conversation it was made for, and nothing once aborted", async () => {
    const s = reference();
    const log = seeded(s);
    const f = feeder(s, log);
    await expect(f.beforeRequest({ ...at(1), conversationId: ROOT })).rejects.toThrow(
      "another replay",
    );
    await expect(f.beforeRequest({ ...at(1), runId: RUN })).rejects.toThrow("another replay");
    const stop = new AbortController();
    stop.abort();
    await f.beforeRequest(at(1, 1, stop.signal));
    expect(log.appendCalls).toBe(0);
  });
});

describe("original-coordinate diagnostics", () => {
  it("an unchanged marked recording has no drift; a tampered recorded context has", () => {
    const s = reference();
    expect(recordedRunPermissionDrift(s)).toBe(false);
    const tampered = structuredClone(s);
    const event = tampered.events.find((e) => e.seq === 7);
    // an unrendered revision alone changes no rendered contribution, so no drift
    (event?.payload as PermissionContextV1).scopeRevision = "tampered";
    expect(recordedRunPermissionDrift(tampered)).toBe(false);
    Object.assign(event?.payload as PermissionContextV1, {
      selectedProfile: "approve-for-me",
      effectiveProfile: "approve-for-me",
    });
    expect(recordedRunPermissionDrift(tampered)).toBe(true);
    // a deleted event is caught too, and nothing live is consulted to fill it in
    const deleted = { ...s, events: s.events.filter((e) => e.seq !== 10) };
    expect(recordedRunPermissionDrift(deleted)).toBe(true);
  });
  it("an earlier run's tampered call alone does not count; the replayed run's requests do", () => {
    const s = reference();
    const earlierCall = s.events.find((e) => e.seq === 3);
    if (earlierCall === undefined) throw new Error("no earlier call");
    Object.assign((earlierCall.payload as { request: Record<string, unknown> }).request, {
      permissionContext: { version: 1, contextSeq: 2, hash: "a".repeat(64) },
    });
    expect(recordedRunPermissionDrift(s)).toBe(false);
  });
  it("an unsupported recorded version fails as eval.snapshot_invalid, never as drift", () => {
    const s = reference();
    Object.assign(s.events.find((e) => e.seq === 6)?.payload as object, { version: 2 });
    for (const f of [
      () => recordedRunPermissionDrift(s),
      () => recordedPermissionContext(s, seeded(s), GEN),
    ]) {
      let thrown: unknown;
      try {
        f();
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toMatchObject({ code: "eval.snapshot_invalid", status: 422 });
    }
  });
});

describe("replay loop deps strip the live recorder (structural)", () => {
  const throwing: PermissionContextPort = {
    beforeRequest: () => {
      throw new Error("the live permission recorder ran in a replay");
    },
  };
  const live = {
    eventLog: {},
    log: {},
    hooks: { live: true },
    subagentProgress: async () => {},
    compactionProgress: {},
    skillForks: {},
    permissionContext: throwing,
    get db() {
      return "live-db";
    },
  } as unknown as LoopDeps;
  it("drops the live recorder and installs only the recorded feeder", () => {
    const recorded: PermissionContextPort = { beforeRequest: async () => {} };
    const out = replayLoopDeps(live, {
      toolPipeline: {} as LoopDeps["toolPipeline"],
      registry: {} as LoopDeps["registry"],
      permissionContext: recorded,
    });
    expect(out.permissionContext).toBe(recorded);
    expect(out.hooks).toBeUndefined();
    expect(out.subagentProgress).toBeUndefined();
    expect(out.compactionProgress).toBeUndefined();
    expect(out.skillForks).toBeUndefined();
    expect(out.db).toBe("live-db");
  });
  it("leaves no permission boundary at all for an unmarked recording", () => {
    const out = replayLoopDeps(live, {
      toolPipeline: {} as LoopDeps["toolPipeline"],
      registry: {} as LoopDeps["registry"],
    });
    expect("permissionContext" in out).toBe(false);
  });
});

/** Gate 9.5 (permission context replay spec B4): reviews and managed paths in recordings. */
describe("recorded reviews and managed device paths", () => {
  const RUN = "r";
  const DEVICE = "00000000-0000-4000-8000-000000000002";
  const managed = {
    permissionContextVersion: 1 as const,
    deviceId: DEVICE,
    roots: { workspace: "/w", skills: "/s", tmp: "/t" },
    workingRoot: "/w",
  };
  const review = {
    profile: "approve-for-me" as const,
    profileRevision: 3,
    scopeRevision: "scope-3",
    decisionSource: "review-model" as const,
    decision: "deny" as const,
    by: "classifier" as const,
    rule: null,
    reason: "Sends data out",
    commandHash: "a".repeat(64),
  };
  /** One step: a Bash call with a recorded review, a Read without one, then a marked path. */
  function recording(opts: { review?: unknown; paths?: unknown } = {}): CaseSnapshot {
    const events: CaseSnapshot["events"] = [];
    const ev = (type: string, payload: unknown) =>
      events.push({ seq: events.length + 1, type, payload, runId: RUN, createdAt: "" } as never);
    ev("assistant_message", {
      step: 1,
      stopReason: "tool_use",
      content: [
        { type: "tool_call", id: "c0", name: "Bash", input: { command: "curl x" } },
        { type: "tool_call", id: "c1", name: "Read", input: { path: "/w/a" } },
      ],
    });
    ev("device_paths", opts.paths ?? managed);
    ev("tool_result", {
      step: 1,
      callId: "c0",
      toolKey: "Bash",
      content: "Denied",
      isError: true,
      ...(opts.review !== undefined && { review: opts.review }),
    });
    ev("tool_result", { step: 1, callId: "c1", toolKey: "Read", content: "a", isError: false });
    return {
      version: 1,
      orgId: "o",
      conversationId: "c",
      runId: RUN,
      agentId: "a",
      agentVersion: 1,
      events,
      definitions: {},
      toolSpecs: {},
    };
  }

  it("copies a recorded review exactly and leaves a result without one without one", () => {
    const calls = recordedCalls(recording({ review }));
    expect(calls[0]?.review).toEqual(review);
    expect(Object.keys(calls[0]?.review ?? {})).toEqual(Object.keys(review));
    expect(calls[1]).not.toHaveProperty("review");
    expect(recordedCalls(recording())[0]).not.toHaveProperty("review");
  });

  it("refuses an invalid recorded review instead of repairing it", () => {
    let thrown: unknown;
    try {
      recordedCalls(recording({ review: { ...review, decision: "maybe" } }));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toMatchObject({ code: "eval.snapshot_invalid" });
  });

  it("keeps a managed device_paths payload whole; a legacy one keeps its roots-and-level shape", () => {
    expect(recordedCalls(recording())[0]?.devicePaths).toEqual(managed);
    const legacy = { roots: managed.roots, tier: "dev", isolation: "sandbox", extra: 1 };
    expect(recordedCalls(recording({ paths: legacy }))[0]?.devicePaths).toEqual({
      roots: managed.roots,
      tier: "dev",
      isolation: "sandbox",
    });
  });

  /** An in-memory log with what RecordedToolPipeline reads and writes. */
  function fakeLog(assistant: unknown, latestPaths?: unknown) {
    const written: { type: string; payload: Record<string, unknown>; idemKey?: string }[] = [];
    const log = {
      async findByIdem(_c: string, key: string) {
        if (key.startsWith("assistant")) return { type: "assistant_message", payload: assistant };
        return written.find((e) => e.idemKey === key);
      },
      async latestOfType() {
        return latestPaths === undefined ? undefined : { seq: 4, payload: latestPaths };
      },
      async append(_c: string, events: typeof written) {
        written.push(...events);
        return events;
      },
    };
    return { log, written };
  }
  const ctx = {
    orgId: "o",
    conversationId: "e",
    runId: "g",
    step: 1,
  } as unknown as Parameters<RecordedToolPipeline["runStep"]>[0];

  it("a matched result carries the recorded review verbatim; an unmatched one carries none", async () => {
    const s = recording({ review });
    const { log, written } = fakeLog({
      step: 1,
      content: [
        { type: "tool_call", id: "n0", name: "Bash", input: { command: "curl x" } },
        { type: "tool_call", id: "n1", name: "Read", input: { path: "/elsewhere" } },
      ],
    });
    const pipeline = new RecordedToolPipeline({
      eventLog: log as never,
      recordings: recordedCalls(s),
      beforeStep: async () => "continue",
    });
    await pipeline.runStep(ctx);
    const results = written.filter((e) => e.type === "tool_result").map((e) => e.payload);
    expect(results[0]).toMatchObject({ content: "Denied", isError: true, review });
    expect(results[0]?.review).not.toBe(recordedCalls(s)[0]?.review);
    expect(results[1]).toMatchObject({ content: REPLAY_NO_RECORDING, isError: true });
    expect(results[1]).not.toHaveProperty("review");
    // the review never joins the content, and nothing is reviewed again: no other event is written
    expect(written.map((e) => e.type)).toEqual([
      "device_paths",
      "tool_call_started",
      "tool_result",
      "tool_call_started",
      "tool_result",
    ]);
  });

  it("inserts the whole managed payload, even after a legacy event with the same roots", async () => {
    const s = recording();
    const assistant = {
      step: 1,
      content: [{ type: "tool_call", id: "n1", name: "Read", input: { path: "/w/a" } }],
    };
    const legacy = fakeLog(assistant, { roots: managed.roots });
    await new RecordedToolPipeline({
      eventLog: legacy.log as never,
      recordings: recordedCalls(s),
      beforeStep: async () => "continue",
    }).runStep(ctx);
    expect(legacy.written[0]).toMatchObject({ type: "device_paths", payload: managed });
    expect(legacy.written[0]?.idemKey).toMatch(/^device_paths:permission-v1:[a-f0-9]{64}:4$/);
    // the same managed payload already latest: nothing more
    const same = fakeLog(assistant, managed);
    await new RecordedToolPipeline({
      eventLog: same.log as never,
      recordings: recordedCalls(s),
      beforeStep: async () => "continue",
    }).runStep(ctx);
    expect(same.written.map((e) => e.type)).toEqual(["tool_call_started", "tool_result"]);
  });
});
