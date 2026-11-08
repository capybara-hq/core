import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { ConversationEvent } from "../src/lib/conversations";
import { invalidateAfterPlatformCall, isPlatformCallDone } from "../src/lib/query/conversation";

/** An agent's Platform call changes what the pages show: the web marks its cached reads stale. */

const result = (toolKey: string, isError: boolean): ConversationEvent =>
  ({
    type: "tool_result",
    conversationId: "c1",
    seq: 9,
    runId: "r1",
    createdAt: "2026-11-08T06:20:00.000Z",
    payload: { step: 1, callId: "k1", toolKey, content: "{}", isError },
  }) as ConversationEvent;

describe("Platform call invalidation", () => {
  it("only a Platform call that went through counts", () => {
    expect(isPlatformCallDone(result("Platform", false))).toBe(true);
    expect(isPlatformCallDone(result("Platform", true))).toBe(false);
    expect(isPlatformCallDone(result("CurrentTime", false))).toBe(false);
  });

  it("marks every read stale, fresh-forever ones included, but never an event log", async () => {
    const qc = new QueryClient();
    const mine = ["org", "o1", "agents", "a1", "profile"];
    const config = ["org", "o1", "extensions", "todo", "tools"];
    const log = ["org", "o1", "conversation", "c1", "events"];
    for (const k of [mine, config, log]) qc.setQueryData(k, { v: 1 });
    await invalidateAfterPlatformCall(qc);
    expect(qc.getQueryState(mine)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(config)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(log)?.isInvalidated).toBe(false);
  });
});
