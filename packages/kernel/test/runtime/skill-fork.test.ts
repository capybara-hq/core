import { describe, expect, it } from "vitest";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { ApiError } from "../../src/errors.js";
import {
  FORK_STORAGE_DOWN_TEXT,
  FORK_UNREADABLE_TEXT,
  forkBoundary,
  forkRenderFailureText,
} from "../../src/runtime/subagents/skill-fork.js";

/** Phase D: the pure parts of forked skills (batch 3 review C1, m5). */

const msg = (seq: number, fork = false): ConversationEvent =>
  ({
    conversationId: "c",
    seq,
    runId: null,
    createdAt: new Date(0),
    type: "user_message",
    payload: {
      content: [{ type: "text", text: `m${seq}` }],
      authorAccountId: "a",
      ...(fork && {
        skill: {
          id: "s",
          version: 1,
          source: "p/",
          name: "review",
          arguments: "",
          mode: "fork",
          agentType: "general-purpose",
        },
      }),
    },
  }) as ConversationEvent;

describe("forkBoundary", () => {
  it("stops right after the run's own fork invocation (messages after it wait)", () => {
    const out = forkBoundary([msg(1), msg(2, true), msg(3)], 2);
    expect(out.map((m) => m.seq)).toEqual([1, 2]);
  });

  it("stops before another fork invocation; a run without a fork trigger absorbs plain messages", () => {
    expect(forkBoundary([msg(1), msg(2, true), msg(3)], 1).map((m) => m.seq)).toEqual([1]);
    expect(forkBoundary([msg(4), msg(5)], 4).map((m) => m.seq)).toEqual([4, 5]);
  });
});

describe("forkRenderFailureText (m5)", () => {
  it("an unreadable SKILL.md and a storage outage get different reports", () => {
    const unreadable = new ApiError("storage.unavailable", "x", [
      { reason: "skill_unreadable", skillId: "s", name: "review" },
    ]);
    const down = new ApiError("storage.unavailable", "File storage is temporarily unavailable");
    expect(forkRenderFailureText(unreadable)).toBe(FORK_UNREADABLE_TEXT);
    expect(forkRenderFailureText(down)).toBe(FORK_STORAGE_DOWN_TEXT);
    expect(FORK_STORAGE_DOWN_TEXT).not.toBe(FORK_UNREADABLE_TEXT);
  });
});
