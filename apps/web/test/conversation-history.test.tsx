// Conversation history in pages (history paging spec 2026-11-07): the first paint is the log's last
// page, the thread's top edge reads the page before it, and the readers of the log that need facts
// from above the window read the server's lists instead.
import { act, cleanup, fireEvent, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationEvent } from "../src/lib/conversations";
import {
  appendEvents,
  type EventWindow,
  eventsQuery,
  hasBackgroundTasks,
  loadEarlierEvents,
  mergeWindows,
} from "../src/lib/query/conversation";
import { useStopUnderWay } from "../src/lib/stop";
import { mayHaveSubagents } from "../src/lib/subagents";
import { buildTimeline } from "../src/lib/timeline";
import { type Call, json, stubApi } from "./support/api";
import {
  CONV,
  ev,
  FakeEventSource,
  renderChatRoute,
  runStarted,
  userMsg,
} from "./support/conversation";
import { resetNavigation } from "./support/navigation";
import { testQueryClient } from "./support/query";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));

const BASE = "/api/v1/orgs/o1/conversations/c1";

beforeEach(() => {
  resetNavigation("/chat/c1");
  vi.stubGlobal("EventSource", FakeEventSource);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  FakeEventSource.instances = [];
});

const finished = (seq: number, runId: string) =>
  ev(seq, "run_finished", { reason: "completed", consumedUpToSeq: seq - 1 }, runId);
const seqs = (w: EventWindow | undefined) => (w?.events ?? []).map((e) => e.seq);
const win = (events: ConversationEvent[], turnsBefore = 0): EventWindow => ({
  events,
  turnsBefore,
});

/** 1 "early" · 2-3 run r1 · 4 "mid" · 5 "late" · 6 run r2 going. */
const LOG = [
  userMsg(1, "early"),
  runStarted(2, "r1"),
  finished(3, "r1"),
  userMsg(4, "mid"),
  userMsg(5, "late"),
  runStarted(6, "r2"),
];

/** The events route as the kernel pages it: `before=end` the last two, `before=4` the rest. */
function eventsRoute(fail = false) {
  return (c: Call) => {
    const before = new URL(c.url, "http://x").searchParams.get("before");
    if (before === "end") return json(200, { events: LOG.slice(3), turnsBefore: 1 });
    if (fail) return json(500, { error: { code: "internal", message: "x" } });
    if (before === "4") return json(200, { events: LOG.slice(0, 3), turnsBefore: 0 });
    throw new Error(`unexpected ${c.url}`);
  };
}

/** The server's routes: the row and the events route given. */
const routes = (events: (c: Call) => Response) => ({
  [`GET ${BASE}`]: () => json(200, CONV("c1")),
  [`GET ${BASE}/events`]: events,
  [`GET ${BASE}/agent-tree`]: () =>
    json(200, {
      root: {
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
      },
    }),
});

describe("the conversation page reads its history in pages", () => {
  it("paints the last page, then reads the page before it from the thread's top edge", async () => {
    const calls = stubApi({ [`GET ${BASE}/events`]: eventsRoute() });
    const { calls: server } = await renderChatRoute({ routes: routes(eventsRoute()) });
    expect(server.map((c) => c.url)).toContain(`${BASE}/events?before=end&limit=200`);
    // a window that may hide a dispatch or a background launch reads the server's lists
    expect(server.map((c) => c.url.split("?")[0])).toEqual(
      expect.arrayContaining([
        `${BASE}/subagents`,
        `${BASE}/usage`,
        `${BASE}/agent-tree`,
        `${BASE}/background-tasks`,
      ]),
    );
    expect(screen.getByText("late")).toBeTruthy();
    expect(screen.queryByText("early")).toBeNull();
    // runs above the window count: r1 above, r2 here
    expect(screen.getByText(/^Turn 2 · /)).toBeTruthy();
    const edge = document.querySelector('[data-part="thread-history"]');
    expect(edge?.getAttribute("data-state")).toBe("more");
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Load earlier messages" })),
    );
    await vi.waitFor(() => expect(screen.getByText("early")).toBeTruthy());
    expect(calls.map((c) => c.url)).toContain(`${BASE}/events?before=4&limit=200`);
    expect(screen.getByText("Beginning of conversation")).toBeTruthy();
    expect(screen.getByText(/^Turn 2 · /)).toBeTruthy();
    // the stream still resumes at the end
    expect(FakeEventSource.instances.map((e) => e.url)).toEqual([`${BASE}/stream?after=6`]);
  });

  it("a failed read shows Retry, which reads it again", async () => {
    stubApi({ [`GET ${BASE}/events`]: eventsRoute(true) });
    await renderChatRoute({ routes: routes(eventsRoute()) });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Load earlier messages" })),
    );
    await vi.waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/Couldn.t load/));
    stubApi({ [`GET ${BASE}/events`]: eventsRoute() });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry" })));
    await vi.waitFor(() => expect(screen.getByText("early")).toBeTruthy());
  });

  it("a log that fits the first page shows no top edge", async () => {
    stubApi({});
    await renderChatRoute({ routes: routes(() => json(200, { events: LOG, turnsBefore: 0 })) });
    expect(screen.getByText("early")).toBeTruthy();
    expect(document.querySelector('[data-part="thread-history"]')).toBeNull();
  });
});

describe("the events window in the cache", () => {
  const key = eventsQuery("o1", "c1").queryKey;

  it("loadEarlierEvents prepends the page before the window with its turnsBefore", async () => {
    const calls = stubApi({ [`GET ${BASE}/events`]: eventsRoute() });
    const qc = testQueryClient();
    qc.setQueryData(key, win(LOG.slice(3), 1));
    expect(await loadEarlierEvents(qc, "o1", "c1")).toEqual({ added: 3 });
    expect(seqs(qc.getQueryData<EventWindow>(key))).toEqual([1, 2, 3, 4, 5, 6]);
    expect(qc.getQueryData<EventWindow>(key)?.turnsBefore).toBe(0);
    // at the beginning nothing is read
    expect(await loadEarlierEvents(qc, "o1", "c1")).toEqual({ added: 0 });
    expect(calls).toHaveLength(1);
  });

  it("appending keeps the window contiguous: an event above its start is dropped", () => {
    const qc = testQueryClient();
    qc.setQueryData(key, win(LOG.slice(3), 1));
    expect(appendEvents(qc, "o1", "c1", [userMsg(2, "x"), userMsg(7, "y")]).added).toBe(1);
    expect(seqs(qc.getQueryData<EventWindow>(key))).toEqual([4, 5, 6, 7]);
  });

  it("windows unite when they overlap or touch; a gap lets the newer read win", () => {
    const a = win(LOG.slice(0, 4));
    expect(seqs(mergeWindows(a, win(LOG.slice(4), 1)))).toEqual([1, 2, 3, 4, 5, 6]);
    expect(mergeWindows(a, win(LOG.slice(4), 1)).turnsBefore).toBe(0);
    expect(seqs(mergeWindows(win(LOG.slice(3), 1), a))).toEqual([1, 2, 3, 4, 5, 6]);
    const later = win([userMsg(9, "far")], 3);
    expect(mergeWindows(a, later)).toBe(later);
  });

  it("a window above the beginning may hide sub-agents and background tasks", () => {
    expect(mayHaveSubagents(LOG)).toBe(false);
    expect(mayHaveSubagents(LOG.slice(3))).toBe(true);
    expect(hasBackgroundTasks(LOG)).toBe(false);
    expect(hasBackgroundTasks(LOG.slice(3))).toBe(true);
  });

  it("a stop under way is not released by earlier run ends loaded above the window", () => {
    const fallback = () => Promise.resolve();
    const { result, rerender } = renderHook(
      ({ events }: { events: ConversationEvent[] }) => useStopUnderWay("c1", events, fallback),
      { initialProps: { events: LOG.slice(3) } },
    );
    act(() => result.current.begin());
    rerender({ events: LOG });
    expect(result.current.requested).toBe(true);
    rerender({ events: [...LOG, finished(7, "r2")] });
    expect(result.current.requested).toBe(false);
  });
});

describe("a handed-back sub-agent's end entry across a page edge", () => {
  const sub = { subagentId: "ch1", childRunId: "run-ch1" };
  const report = ev(
    2,
    "subagent_delivery",
    { ...sub, description: "Scan docs", triggerAccountId: "a1", kind: "report", text: "ok" },
    null,
  );
  const done = (seq: number) =>
    ev(
      seq,
      "subagent_finished",
      {
        ...sub,
        callId: "c1",
        status: "completed",
        toolCalls: 1,
        durationMs: 1,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
      null,
    );
  const log = [userMsg(1, "go"), report, finished(3, "r0"), userMsg(4, "next"), done(5)];
  const ends = (events: ConversationEvent[]) =>
    buildTimeline(events, [], new Map(), "en").filter(
      (e) => e.kind === "delivery" && e.delivery === "finished",
    );

  it("is drawn once when the report's page loads, never twice", () => {
    // the report above the window: no end entry yet (it is named by the report)
    expect(ends(log.slice(3))).toHaveLength(0);
    // prepended: exactly one
    expect(ends(log)).toHaveLength(1);
  });
});
