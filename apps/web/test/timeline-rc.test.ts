import { describe, expect, it } from "vitest";
import type { ConversationEvent, ToolInfo } from "../src/lib/conversations";
import { buildTimeline, type TimelineEntry, toolKeysOf } from "../src/lib/timeline";

/**
 * A conversation logged by a release candidate keeps its old tool keys (append-only; tool naming
 * spec §9). The page never names them itself: `GET …/tools` answers an old builtin key with its
 * current tool and `aliasOf`, and the timeline maps the call through it.
 */

let t = 0;
function ev(seq: number, type: string, payload: unknown, runId: string | null = "r1") {
  t += 1000;
  return {
    conversationId: "c1",
    seq,
    type,
    payload,
    runId,
    createdAt: new Date(t).toISOString(),
  } as ConversationEvent;
}

// the rc keys, as the old log holds them
const RC_AGENT = "agent";
const RC_BASH = "sandbox_bash";

/** What the kernel answers for the rc keys (`aliasOf` set, old parameter names). */
const INFO = new Map<string, ToolInfo>([
  [
    RC_AGENT,
    {
      key: RC_AGENT,
      aliasOf: "Agent",
      title: null,
      kind: "tool",
      sandbox: false,
      keyArgs: ["description", "subagent_type"],
      tool: null,
      source: { kind: "builtin" },
    },
  ],
  [
    RC_BASH,
    {
      key: RC_BASH,
      aliasOf: "Bash",
      title: null,
      kind: "command",
      sandbox: true,
      keyArgs: ["command"],
      tool: null,
      source: { kind: "builtin" },
    },
  ],
]);

const rcEvents = (): ConversationEvent[] => [
  ev(1, "user_message", { content: [{ type: "text", text: "go" }], authorAccountId: "a1" }, null),
  ev(2, "run_started", { agentVersion: 1, model: { provider: "p", model: "m" } }),
  ev(3, "assistant_message", {
    step: 1,
    stopReason: "tool_use",
    content: [
      {
        type: "tool_call",
        id: "k1",
        name: RC_AGENT,
        input: { description: "Scan docs", prompt: "Do it", subagent_type: "general-purpose" },
      },
      { type: "tool_call", id: "b1", name: RC_BASH, input: { command: "ls -la" } },
    ],
  }),
  ev(4, "subagent_dispatched", {
    step: 1,
    callId: "k1",
    subagentId: "ch1",
    childRunId: "run-ch1",
    agentType: "general-purpose",
    description: "Scan docs",
    resumed: false,
    model: { provider: "p", model: "m" },
  }),
  ev(5, "tool_call_started", { step: 1, callId: "b1", toolKey: "Bash", specHash: "h" }),
  ev(6, "tool_result", {
    step: 1,
    callId: "b1",
    toolKey: RC_BASH,
    content: "a\nb",
    isError: false,
  }),
  ev(7, "subagent_waiting", {
    subagentId: "ch1",
    childRunId: "run-ch1",
    kind: "approval",
    approvalId: "ap1",
    toolKey: RC_BASH,
  }),
];

const ofKind = <K extends TimelineEntry["kind"]>(entries: TimelineEntry[], kind: K) =>
  entries.filter((e): e is Extract<TimelineEntry, { kind: K }> => e.kind === kind);

describe("a conversation logged before the tool rename", () => {
  it("asks the kernel about the logged keys", () => {
    expect(toolKeysOf(rcEvents())).toEqual([RC_AGENT, RC_BASH]);
  });

  it("an rc agent call is a sub-agent row and an rc bash call a Bash row with its command", () => {
    const out = buildTimeline(rcEvents(), [], INFO, "en");
    const [group] = ofKind(out, "subagents");
    expect(group?.rows.map((r) => r.row)).toEqual([
      expect.objectContaining({
        id: "ch1",
        description: "Scan docs",
        agentType: "general-purpose",
        status: "waiting",
        waiting: "approval",
      }),
    ]);
    const rows = ofKind(out, "tools").flatMap((g) => g.rows.map((r) => r.row));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: "Bash",
      kind: "command",
      keyArg: "ls -la",
      status: "done",
      detail: { command: "ls -la", output: "a\nb" },
    });
    expect(out.at(-1)).toMatchObject({
      kind: "subagent-wait",
      subagent: { id: "ch1", name: "Scan docs" },
      wait: "approval",
    });
  });
});
