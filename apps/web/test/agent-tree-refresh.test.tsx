// @vitest-environment jsdom
// The agent map's tree reads (agent map spec §9.2): progress is coalesced, structure is prompt.
import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationEvent } from "../src/lib/conversations";
import { makeQueryClient } from "../src/lib/query/client";
import { TREE_PROGRESS_MS, useAgentTree } from "../src/lib/subagents";
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
});
