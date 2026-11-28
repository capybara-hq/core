import { describe, expect, it } from "vitest";
import { COMPACTION_SETTINGS } from "../../src/identity/settings.js";
import { type IdleReturnInput, idleReturnFacts } from "../../src/runtime/idle-return.js";

const settings = COMPACTION_SETTINGS.parse({});
const MIN = 60_000;
const FINISHED = 10_000_000;

const input = (over: Partial<IdleReturnInput> = {}): IdleReturnInput => ({
  startedAt: FINISHED + 31 * MIN,
  previousFinishedAt: FINISHED,
  lastCall: {
    window: 400_000,
    input: 10_000,
    cacheRead: 200_000,
    cacheWrite: 30_000,
    output: 10_000,
    recordedTtl: 3600,
    defaultTtl: 300,
  },
  idleSummary: false,
  settings,
  ...over,
});

describe("idleReturnFacts", () => {
  it("is none for a gap of 29 minutes", () => {
    expect(idleReturnFacts(input({ startedAt: FINISHED + 29 * MIN }))).toBeNull();
  });

  it("is none for a gap of exactly 30 minutes", () => {
    expect(idleReturnFacts(input({ startedAt: FINISHED + 30 * MIN }))).toBeNull();
  });

  it("logs a 31 minute gap with 250k tokens on a 400k window", () => {
    expect(idleReturnFacts(input())).toEqual({
      gapMs: 31 * MIN,
      contextTokens: 250_000,
      threshold: 200_000,
      ttl: 3600,
      idleSummary: false,
    });
  });

  it("is none below the size threshold", () => {
    const base = input().lastCall;
    if (base === null) throw new Error("fixture");
    expect(idleReturnFacts(input({ lastCall: { ...base, cacheRead: 100_000 } }))).toBeNull();
  });

  it("is none without a step call", () => {
    expect(idleReturnFacts(input({ lastCall: null }))).toBeNull();
  });

  it("reports an idle summary written in between", () => {
    expect(idleReturnFacts(input({ idleSummary: true }))?.idleSummary).toBe(true);
  });

  it("reports a 5 minute cache (an opportunity the 30 minute rule leaves out)", () => {
    const base = input().lastCall;
    if (base === null) throw new Error("fixture");
    const facts = idleReturnFacts(
      input({ lastCall: { ...base, recordedTtl: undefined, defaultTtl: 300 } }),
    );
    expect(facts?.ttl).toBe(300);
  });

  it("has a null ttl when neither a recorded nor a declared lifetime exists", () => {
    const base = input().lastCall;
    if (base === null) throw new Error("fixture");
    const facts = idleReturnFacts(
      input({ lastCall: { ...base, recordedTtl: undefined, defaultTtl: undefined } }),
    );
    expect(facts?.ttl).toBeNull();
  });
});
