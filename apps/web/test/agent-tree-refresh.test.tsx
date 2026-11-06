// @vitest-environment jsdom
// The agent map's tree reads (agent map spec §9.2): progress is coalesced, structure is prompt.
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationEvent } from "../src/lib/conversations";
import { makeQueryClient } from "../src/lib/query/client";
import {
  TREE_PROGRESS_MS,
  TREE_TRAILING_READS,
  useAgentTree,
  useTreeLookup,
} from "../src/lib/subagents";
import { type Call, json, stubApi } from "./support/api";
import { ev } from "./support/conversation";

const TREE = `/api/v1/orgs/o1/conversations/c1/agent-tree`;
const ROOT = {
  id: "c1",
  description: "",
  agentType: null,
  status: "running",
  model: null,
  startedAt: null,
  finishedAt: null,
  durationMs: 0,
  tokens: 0,
  toolCalls: 0,
  children: [],
};

const dispatched = ev(1, "subagent_dispatched", { subagentId: "ch1", description: "x" });
const finished = ev(2, "subagent_finished", { subagentId: "ch1", status: "completed" });

type Props = {
  events: readonly ConversationEvent[];
  progress: Readonly<Record<string, { step: number }>>;
};

/** A tree whose grandchild (below the root's children) has the status `deep`. */
const deepTree = (deep: string) => ({
  ...ROOT,
  children: [
    {
      ...ROOT,
      id: "ch1",
      status: "running",
      children: [{ ...ROOT, id: "gc1", status: deep, children: [] }],
    },
  ],
});

let calls: Call[];
const reads = () => calls.filter((c) => c.url.startsWith(TREE)).length;

function mount(initial: Props) {
  const qc = makeQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return renderHook((p: Props) => useAgentTree("o1", "c1", p.events, p.progress, true), {
    wrapper,
    initialProps: initial,
  });
}

/** Lets the fetches and their answers settle (fake timers: microtasks only). */
const settle = () => act(async () => await vi.advanceTimersByTimeAsync(0));

beforeEach(() => {
  vi.useFakeTimers();
  calls = stubApi({ [`GET ${TREE}`]: () => json(200, { root: ROOT }) });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useAgentTree", () => {
  it("many progress steps in quick succession read the tree a bounded number of times", async () => {
    const { rerender } = mount({ events: [dispatched], progress: {} });
    await settle();
    expect(reads()).toBe(1);
    // 40 steps from four agents within one second
    for (let i = 1; i <= 40; i++) {
      rerender({ events: [dispatched], progress: { [`ch${i % 4}`]: { step: i } } });
      await act(async () => await vi.advanceTimersByTimeAsync(25));
    }
    await act(async () => await vi.advanceTimersByTimeAsync(TREE_PROGRESS_MS * 2));
    await settle();
    // the first read and at most one per throttle window
    expect(reads()).toBeGreaterThan(1);
    expect(reads()).toBeLessThanOrEqual(3);
  });

  it("a structural sub-agent event reads the tree at once", async () => {
    const { rerender } = mount({ events: [dispatched], progress: {} });
    await settle();
    expect(reads()).toBe(1);
    rerender({ events: [dispatched, finished], progress: {} });
    await settle();
    expect(reads()).toBe(2);
  });

  it("a grandchild still active after a read: one more read per window, bounded, none once it ends", async () => {
    let deep = "running";
    calls = stubApi({ [`GET ${TREE}`]: () => json(200, { root: deepTree(deep) }) });
    mount({ events: [dispatched], progress: {} });
    await settle();
    expect(reads()).toBe(1);
    // its end reaches no event of the root's log: a trailing read picks it up
    await act(async () => await vi.advanceTimersByTimeAsync(TREE_PROGRESS_MS));
    await settle();
    expect(reads()).toBe(2);
    // still running: bounded, no polling
    await act(async () => await vi.advanceTimersByTimeAsync(TREE_PROGRESS_MS * 20));
    await settle();
    expect(reads()).toBe(1 + TREE_TRAILING_READS);

    // new progress allows the trailing reads again; once nothing below is active they stop
    cleanup();
    calls = stubApi({ [`GET ${TREE}`]: () => json(200, { root: deepTree(deep) }) });
    const { rerender } = mount({ events: [dispatched], progress: {} });
    await settle();
    deep = "idle";
    rerender({ events: [dispatched], progress: { gc1: { step: 1 } } });
    await act(async () => await vi.advanceTimersByTimeAsync(TREE_PROGRESS_MS));
    await settle();
    const after = reads();
    await act(async () => await vi.advanceTimersByTimeAsync(TREE_PROGRESS_MS * 10));
    await settle();
    expect(reads()).toBe(after);
  });

  it("a tree with only the root's children active schedules no read of its own", async () => {
    calls = stubApi({
      [`GET ${TREE}`]: () => json(200, { root: { ...ROOT, children: [{ ...ROOT, id: "ch1" }] } }),
    });
    mount({ events: [dispatched], progress: {} });
    await settle();
    await act(async () => await vi.advanceTimersByTimeAsync(TREE_PROGRESS_MS * 10));
    await settle();
    expect(reads()).toBe(1);
  });
});

describe("useTreeLookup", () => {
  const deepWait = ev(3, "subagent_waiting", {
    subagentId: "gc1",
    childRunId: "run-gc1",
    path: ["ch1", "gc1"],
    kind: "approval",
    toolKey: "Bash",
  });

  it("reads the tree only while a deep wait's branch is unresolved, then keeps its answer", async () => {
    calls = stubApi({ [`GET ${TREE}`]: () => json(200, { root: deepTree("waiting") }) });
    const qc = makeQueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result, rerender } = renderHook(
      (p: { events: readonly ConversationEvent[] }) => useTreeLookup("o1", "c1", p.events, true),
      { wrapper, initialProps: { events: [dispatched, deepWait] } },
    );
    await settle();
    expect(reads()).toBe(1);
    expect(result.current?.agentStatus("gc1")).toBe("waiting");
    // the branch's child ended after the wait: the map's invalidations no longer read it here
    const ended = ev(4, "subagent_finished", { subagentId: "ch1", status: "completed" });
    rerender({ events: [dispatched, deepWait, ended] });
    await act(async () => {
      await qc.invalidateQueries({ queryKey: ["org", "o1"] });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(reads()).toBe(1);
    // what it read still names the agents
    expect(result.current?.agentStatus("gc1")).toBe("waiting");
  });

  it("never reads the tree of a conversation that is not a root (the API answers 404)", async () => {
    calls = stubApi({
      [`GET ${TREE}`]: () => json(404, { error: { code: "conversation.not_found" } }),
    });
    const qc = makeQueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(
      (p: { events: readonly ConversationEvent[] }) => useTreeLookup("o1", "c1", p.events, false),
      { wrapper, initialProps: { events: [dispatched, deepWait] } },
    );
    await settle();
    expect(reads()).toBe(0);
    expect(result.current).toBeUndefined();
  });
});
