// @vitest-environment jsdom
// The composer's agents chip numbers (design spec §6.16.29, acceptance item AC3): every sub-agent
// the page knows, how many run and wait, from what the page already reads.
import { describe, expect, it } from "vitest";
import type { AgentTreeNode, SubagentView } from "../src/lib/conversations";
import { agentsSummary } from "../src/lib/subagents";
import { ev } from "./support/conversation";

const dispatched = (seq: number, id: string) =>
  ev(seq, "subagent_dispatched", { subagentId: id, callId: `k-${id}`, description: id });
const finished = (seq: number, id: string, status = "completed") =>
  ev(seq, "subagent_finished", { subagentId: id, callId: `k-${id}`, status });
const waitingEv = (seq: number, id: string, path?: string[]) =>
  ev(seq, "subagent_waiting", {
    subagentId: id,
    childRunId: `run-${id}`,
    ...(path ? { path } : {}),
    kind: "approval",
    toolKey: "Bash",
  });

const view = (id: string, status: string, o: Partial<SubagentView> = {}): SubagentView =>
  ({
    id,
    agentType: "general-purpose",
    description: id,
    status,
    toolCalls: 0,
    startedAt: "2026-11-07T00:00:00.000Z",
    finishedAt: null,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    pendingApprovalIds: [],
    pendingQuestionIds: [],
    ...o,
  }) as SubagentView;

const node = (
  id: string,
  status: AgentTreeNode["status"],
  children: AgentTreeNode[] = [],
): AgentTreeNode => ({
  id,
  description: id,
  agentType: null,
  status,
  model: null,
  startedAt: null,
  finishedAt: null,
  durationMs: 0,
  tokens: 0,
  toolCalls: 0,
  children,
});

const sum = (o: Partial<Parameters<typeof agentsSummary>[0]>) =>
  agentsSummary({ events: [], views: undefined, progress: {}, tree: undefined, ...o });

describe("agentsSummary", () => {
  it("nothing dispatched: no agents", () => {
    expect(sum({})).toEqual({ count: 0, running: 0, waiting: 0 });
  });

  it("the log's children before the list answers: dispatched runs, finished does not", () => {
    expect(sum({ events: [dispatched(1, "a"), dispatched(2, "b"), finished(3, "a")] })).toEqual({
      count: 2,
      running: 1,
      waiting: 0,
    });
  });

  it("the list's statuses win over the log; a person's wait is a wait", () => {
    const events = [dispatched(1, "a"), dispatched(2, "b"), dispatched(3, "c")];
    const views = [
      view("a", "completed"),
      view("b", "waiting", { pendingApprovalIds: ["ap1"] }),
      view("c", "queued"),
    ];
    expect(sum({ events, views })).toEqual({ count: 3, running: 1, waiting: 1 });
  });

  it("the tree adds every depth; the root is never counted", () => {
    const tree = node("root", "running", [
      node("a", "running", [node("a1", "running"), node("a2", "idle", [node("a21", "idle")])]),
    ]);
    expect(sum({ events: [dispatched(1, "a")], tree })).toEqual({
      count: 4,
      running: 2,
      waiting: 0,
    });
  });

  it("a child waiting for its own sub-agents counts what they do", () => {
    const events = [dispatched(1, "a")];
    const views = [view("a", "waiting")];
    // no tree yet: its branch works, counted once
    expect(sum({ events, views })).toEqual({ count: 1, running: 1, waiting: 0 });
    // the tree shows a grandchild running: that one runs
    const tree = node("root", "running", [node("a", "waiting", [node("a1", "running")])]);
    expect(sum({ events, views, tree })).toEqual({ count: 2, running: 1, waiting: 0 });
    // the grandchild waits for a person: the branch waits
    const asks = node("root", "running", [node("a", "waiting", [node("a1", "waiting")])]);
    expect(sum({ events, views, tree: asks })).toEqual({ count: 2, running: 0, waiting: 1 });
    // no tree, but the root log holds the grandchild's open wait
    const deepWait = [...events, waitingEv(2, "a1", ["a", "a1"])];
    expect(sum({ events: deepWait, views })).toEqual({ count: 2, running: 0, waiting: 1 });
  });

  it("a deeper agent's stale status counts only while its branch is active", () => {
    // the tree was read while the grandchild ran; the child has ended since
    const tree = node("root", "running", [node("a", "running", [node("a1", "running")])]);
    expect(
      sum({
        events: [dispatched(1, "a"), finished(2, "a")],
        views: [view("a", "completed")],
        tree,
      }),
    ).toEqual({ count: 2, running: 0, waiting: 0 });
  });

  it("a stale tree never drops the dot: an active child with nothing below it that counts runs", () => {
    const events = [dispatched(1, "a")];
    // the child waits on its sub-agents (no approval or question of its own); the tree read last
    // shows them all ended (a deep agent's restart reaches no event of the root's log)
    const views = [view("a", "waiting")];
    const stale = node("root", "running", [
      node("a", "waiting", [node("a1", "idle"), node("a2", "failed")]),
    ]);
    expect(sum({ events, views, tree: stale })).toEqual({ count: 3, running: 1, waiting: 0 });
    // a running child counts once, never twice
    const runs = [view("a", "running")];
    expect(sum({ events, views: runs, tree: stale })).toEqual({ count: 3, running: 1, waiting: 0 });
    // a child waiting for a person is a wait, whatever the tree says below it
    const asks = [view("a", "waiting", { pendingQuestionIds: ["q1"] })];
    expect(sum({ events, views: asks, tree: stale })).toEqual({ count: 3, running: 0, waiting: 1 });
  });

  it("agents named only by the stream's progress or a wait's path count too", () => {
    expect(
      sum({
        events: [dispatched(1, "a"), waitingEv(2, "a2", ["a", "a1", "a2"])],
        progress: { a: { step: 1 }, b1: { step: 2 } },
      }).count,
    ).toBe(4);
  });
});
