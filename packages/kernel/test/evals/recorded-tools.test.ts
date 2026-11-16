import { describe, expect, it } from "vitest";
import {
  legacyScopeOf,
  REPLAY_NO_RECORDING,
  RecordedToolPipeline,
  recordedCalls,
} from "../../src/evals/recorded-tools.js";
import type { CaseSnapshot } from "../../src/evals/snapshot.js";

type Call = { key: string; hash: string | null; connector?: boolean; spec?: boolean };

/** A one-run snapshot whose assistant message calls `calls`, each recorded with a tool spec. */
function snap(calls: Call[], plugins: { plugin: string; name: string }[] = []): CaseSnapshot {
  const toolSpecs: Record<string, unknown> = {};
  const events: CaseSnapshot["events"] = [];
  let seq = 1;
  const ev = (type: string, payload: unknown) =>
    events.push({ seq: seq++, type, payload, runId: "r", createdAt: "" } as never);
  ev("assistant_message", {
    step: 1,
    stopReason: "tool_use",
    content: calls.map((c, i) => ({
      type: "tool_call",
      id: `c${i}`,
      name: c.key,
      input: { q: 1 },
    })),
  });
  for (const [i, c] of calls.entries()) {
    const tool = c.key.slice(c.key.indexOf("__") + 2);
    if (c.hash !== null && c.spec !== false) {
      toolSpecs[c.hash] = {
        name: tool,
        description: "d",
        inputSchema: { type: "object" },
        ...(c.connector && { connectorData: { tool } }),
      };
    }
    ev("tool_call_started", {
      step: 1,
      callId: `c${i}`,
      toolKey: c.key,
      specHash: c.hash ?? "",
    });
    ev("tool_result", { step: 1, callId: `c${i}`, toolKey: c.key, content: "ok", isError: false });
  }
  return {
    version: 1,
    orgId: "o",
    conversationId: "c",
    runId: "r",
    agentId: "a",
    agentVersion: 1,
    events,
    definitions: {
      "1": { tools: plugins.map((p) => ({ kind: "plugin", ...p })) } as never,
    },
    toolSpecs: toolSpecs as never,
  };
}

const keys = (s: CaseSnapshot) => recordedCalls(s).map((c) => c.toolKey);

describe("legacy scope from positive evidence", () => {
  it("a connector tool spec and an extension tool spec are read as such", () => {
    const s = snap([
      { key: "docs__search", hash: "h1", connector: true },
      { key: "probe__echo", hash: "h2" },
    ]);
    expect(keys(s)).toEqual(["mcp__docs__search", "plugin__probe__echo"]);
    expect(recordedCalls(s).every((c) => c.legacy === true)).toBe(true);
  });

  it("an extension ref in the definition is evidence for exactly that tool", () => {
    const s = snap([{ key: "probe__echo", hash: null }], [{ plugin: "probe", name: "echo" }]);
    expect(keys(s)).toEqual(["plugin__probe__echo"]);
    const other = snap([{ key: "probe__echo", hash: null }], [{ plugin: "probe", name: "second" }]);
    expect(keys(other)).toEqual(["probe__echo"]);
  });

  it("a connector slug equal to an extension name is ambiguous: left unmapped", () => {
    const s = snap(
      [
        { key: "same__search", hash: "h1", connector: true },
        { key: "same__echo", hash: "h2" },
      ],
      [{ plugin: "same", name: "echo" }],
    );
    const scope = legacyScopeOf(s);
    expect(scope.connectorSlugs.has("same") && scope.extensionNames.has("same")).toBe(true);
    expect(keys(s)).toEqual(["same__search", "same__echo"]);
    expect(recordedCalls(s).some((c) => c.legacy)).toBe(false);
  });

  it("a head with no evidence stays unmapped, even when it looks like a plugin name", () => {
    const s = snap([{ key: "ghost__t", hash: null }], [{ plugin: "ghost", name: "other" }]);
    expect(keys(s)).toEqual(["ghost__t"]);
    const noSpec = snap([{ key: "ghost__t", hash: "gone", spec: false }]);
    expect(keys(noSpec)).toEqual(["ghost__t"]);
    expect(recordedCalls(noSpec)[0]?.legacy).toBeUndefined();
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
