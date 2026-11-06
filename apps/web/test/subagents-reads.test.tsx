// @vitest-environment jsdom
// The sub-agent list's reads (AC5): a waiting child with stream progress reads the list again once
// per new step, never once per render (the loop that read `GET …/subagents` ~2.5 times a second).
import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationEvent } from "../src/lib/conversations";
import { makeQueryClient } from "../src/lib/query/client";
import { useSubagents } from "../src/lib/subagents";
import { type Call, json, stubApi } from "./support/api";
import { ev } from "./support/conversation";

const LIST = "/api/v1/orgs/o1/conversations/c1/subagents";
const dispatched = ev(1, "subagent_dispatched", { subagentId: "ch1", description: "x" });
const waitingChild = {
  id: "ch1",
  description: "x",
  agentType: "general-purpose",
  status: "waiting",
  toolCalls: 1,
};

type Props = {
  events: readonly ConversationEvent[];
  progress: Readonly<Record<string, { step: number }>>;
  /** A prop that changes nothing the hook reads: a parent re-render. */
  tick: number;
};

let calls: Call[];
const reads = () => calls.filter((c) => c.url.startsWith(LIST)).length;
const settle = () => act(async () => await vi.advanceTimersByTimeAsync(0));

function mount(initial: Props) {
  const qc = makeQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return renderHook((p: Props) => useSubagents("o1", "c1", p.events, p.progress, undefined), {
    wrapper,
    initialProps: initial,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  calls = stubApi({ [`GET ${LIST}`]: () => json(200, { subagents: [waitingChild], next: null }) });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useSubagents", () => {
  it("a waiting child's progress reads the list once per step, not once per render", async () => {
    const events = [dispatched];
    const progress = { ch1: { step: 1 } };
    const { rerender } = mount({ events, progress, tick: 0 });
    await settle();
    await settle();
    // the first read, then one more for the progress of a child the list shows as waiting
    expect(reads()).toBe(2);
    // re-renders with the same inputs (each answer re-rendered the page) read nothing more
    for (let tick = 1; tick <= 5; tick++) {
      rerender({ events, progress, tick });
      await settle();
    }
    expect(reads()).toBe(2);
    // a new step is a new reason: one more read
    rerender({ events, progress: { ch1: { step: 2 } }, tick: 6 });
    await settle();
    await settle();
    expect(reads()).toBe(3);
  });
});
