import { describe, expect, it } from "vitest";
import {
  coalesceJobId,
  depthExceeded,
  isSelfTriggered,
  subjectKey,
} from "../../src/automations/events/guards.js";

const subject = { kind: "tracker:issue", id: "org:42/a:b", title: "t" };

describe("subjectKey", () => {
  it("contains no colon and is stable", () => {
    const key = subjectKey(subject);
    expect(key).not.toContain(":");
    expect(key).toBe(subjectKey({ ...subject }));
    expect(key).toMatch(/^tracker-issue-[0-9a-f]{16}$/);
  });
  it("differs per id", () => {
    expect(subjectKey({ kind: "k", id: "1", title: "t" })).not.toBe(
      subjectKey({ kind: "k", id: "2", title: "t" }),
    );
  });
});

describe("coalesceJobId", () => {
  it("has the automation prefix and no colon", () => {
    const id = coalesceJobId("auto-1", subject);
    expect(id).toBe(`automation-coalesce-auto-1-${subjectKey(subject)}`);
    expect(id).not.toContain(":");
  });
});

describe("isSelfTriggered", () => {
  const a = { accountId: "acc", agentId: "ag" };
  it("is true only when account and agent both match", () => {
    expect(isSelfTriggered(a, { runAccountId: "acc", runAgentId: "ag" })).toBe(true);
    expect(isSelfTriggered(a, { runAccountId: "acc", runAgentId: "other" })).toBe(false);
    expect(isSelfTriggered(a, { runAccountId: "other", runAgentId: "ag" })).toBe(false);
    expect(isSelfTriggered(a, null)).toBe(false);
  });
});

describe("depthExceeded", () => {
  it("is depth > max", () => {
    expect(depthExceeded(8, 8)).toBe(false);
    expect(depthExceeded(9, 8)).toBe(true);
  });
});
