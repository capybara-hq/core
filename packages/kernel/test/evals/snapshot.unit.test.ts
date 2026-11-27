import { describe, expect, it } from "vitest";
import { runTaskNarrowing, type SnapshotEvent } from "../../src/evals/snapshot.js";

/**
 * A snapshot's sub-agent definition takes the narrowing of its run's task message only: a live
 * snapshot (idle compaction spec §9.4) may hold a later follow-up's task message after the run.
 */

const AT = "2026-11-28T00:00:00.000Z";
const RUN = "run-1";
const NEXT = "run-2";

const narrowing = (tool: string) => ({
  disabledTools: [{ kind: "builtin" as const, name: tool }],
  disabledSkills: [],
});

const task = (seq: number, tool?: string): SnapshotEvent => ({
  seq,
  type: "user_message",
  runId: null,
  createdAt: AT,
  payload: {
    content: [{ type: "text", text: "Do it." }],
    authorAccountId: "acc-1",
    dispatch: {
      parentConversationId: "p",
      parentRunId: "pr",
      callId: `call-${seq}`,
      ...(tool !== undefined && { narrowed: narrowing(tool) }),
    },
  },
});

const ofRun = (seq: number, runId: string, type: SnapshotEvent["type"]): SnapshotEvent => ({
  seq,
  type,
  runId,
  createdAt: AT,
  payload: {},
});

describe("runTaskNarrowing", () => {
  const events: SnapshotEvent[] = [
    task(1),
    ofRun(2, RUN, "run_started"),
    ofRun(3, RUN, "run_finished"),
    task(4, "Bash"),
    ofRun(5, RUN, "run_started"),
    ofRun(6, RUN, "run_finished"),
    task(7, "Write"),
    ofRun(8, NEXT, "run_started"),
  ];

  it("takes the last task message up to the run's last event", () => {
    expect(runTaskNarrowing(events, RUN)).toEqual(narrowing("Bash"));
    expect(runTaskNarrowing(events, NEXT)).toEqual(narrowing("Write"));
  });

  it("ignores a later follow-up's task message", () => {
    // the run's events end at seq 6; the task at seq 7 belongs to the next run
    expect(runTaskNarrowing(events.slice(0, 7), RUN)).toEqual(narrowing("Bash"));
  });

  it("an unfinished run counts up to its latest event", () => {
    expect(runTaskNarrowing(events.slice(0, 5), RUN)).toEqual(narrowing("Bash"));
  });

  it("a run without events in the list counts every event", () => {
    expect(runTaskNarrowing(events, "run-x")).toEqual(narrowing("Write"));
    expect(runTaskNarrowing([task(1)], RUN)).toBeUndefined();
  });
});
