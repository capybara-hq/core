// The conversation page through the query cache (web query cache spec §6): the stream appends to
// the cached log, `changed` frames invalidate their key, and a return reads only what changed.
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import { useConversation } from "../src/components/conversation/useConversation";
import type { ConversationEvent } from "../src/lib/conversations";
import {
  appendEvents,
  CONVERSATION_SIDE_KEYS,
  eventsQuery,
  toolInfoQuery,
} from "../src/lib/query/conversation";
import { keys } from "../src/lib/query/keys";
import { stubApi } from "./support/api";
import { CONV, ev, FakeEventSource, userMsg } from "./support/conversation";
import { testQueryClient } from "./support/query";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));

beforeEach(() => {
  vi.stubGlobal("EventSource", FakeEventSource);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  FakeEventSource.instances = [];
});

const seqs = (list: readonly ConversationEvent[] | undefined) => (list ?? []).map((e) => e.seq);
const msg = (seq: number) => ev(seq, "user_message", { content: [] }, null);

describe("appendEvents", () => {
  it("appendEvents ignores seqs it already holds and keeps order", () => {
    const qc = testQueryClient();
    const key = eventsQuery("o1", "c1").queryKey;
    qc.setQueryData(key, [msg(1), msg(2), msg(3)]);
    const r = appendEvents(qc, "o1", "c1", [msg(3), msg(2), msg(4), msg(6), msg(5)]);
    expect(seqs(qc.getQueryData<ConversationEvent[]>(key))).toEqual([1, 2, 3, 4, 5, 6]);
    expect(r.added).toBe(3);
  });

  it("appends newer events in order, once each, and keeps the list when nothing is new", () => {
    const qc = testQueryClient();
    const key = eventsQuery("o1", "c1").queryKey;
    qc.setQueryData(key, [msg(1)]);
    expect(appendEvents(qc, "o1", "c1", [msg(3), msg(2), msg(3)]).added).toBe(2);
    const list = qc.getQueryData<ConversationEvent[]>(key);
    expect(seqs(list)).toEqual([1, 2, 3]);
    expect(appendEvents(qc, "o1", "c1", [msg(2)]).added).toBe(0);
    expect(qc.getQueryData<ConversationEvent[]>(key)).toBe(list);
  });

  it("does nothing while the log is not cached", () => {
    const qc = testQueryClient();
    expect(appendEvents(qc, "o1", "c1", [msg(1)]).added).toBe(0);
    expect(qc.getQueryData(eventsQuery("o1", "c1").queryKey)).toBeUndefined();
  });
});

describe("conversation query keys", () => {
  it("tool info holds its keys sorted: the same set is one key", () => {
    expect(toolInfoQuery("o1", "c1", ["b", "a"]).queryKey).toEqual(
      toolInfoQuery("o1", "c1", ["a", "b"]).queryKey,
    );
  });

  it("the side keys are the conversation's pieces outside the log, scoped to the org", () => {
    const side = CONVERSATION_SIDE_KEYS("o1", "c1");
    for (const k of side) expect(k.slice(0, 2)).toEqual(["org", "o1"]);
    expect(side).toContainEqual(keys.org("o1").conversation("c1").queue());
    expect(side).toContainEqual(keys.org("o1").conversation("c1").row());
    expect(side).not.toContainEqual(keys.org("o1").conversation("c1").events());
  });
});

describe("useConversation and the cache", () => {
  const BASE = "/api/v1/orgs/o1/conversations/c1";
  function Probe() {
    const c = useConversation("o1", "c1");
    return <p data-testid="seqs">{c.events.map((e) => e.seq).join(",")}</p>;
  }
  /** A client holding c1's row and its log `[1, 2]`, as a first load leaves it. */
  function cached() {
    const qc = testQueryClient();
    qc.setQueryData(eventsQuery("o1", "c1").queryKey, [userMsg(1, "hi"), userMsg(2, "there")]);
    qc.setQueryData(keys.org("o1").conversation("c1").row(), CONV("c1").conversation);
    return qc;
  }
  const mount = (qc: ReturnType<typeof testQueryClient>) =>
    render(
      <QueryClientProvider client={qc}>
        <NextIntlClientProvider locale="en" messages={en}>
          <Probe />
        </NextIntlClientProvider>
      </QueryClientProvider>,
    );
  const sideKeys = (qc: ReturnType<typeof testQueryClient>) => {
    const spy = vi.spyOn(qc, "invalidateQueries");
    return () => spy.mock.calls.map(([f]) => JSON.stringify(f?.queryKey));
  };

  it("the stream opens from the cached last seq and appends to the cached log", async () => {
    stubApi({ [`GET ${BASE}`]: () => new Response(JSON.stringify(CONV("c1"))) });
    const qc = cached();
    const view = mount(qc);
    expect(FakeEventSource.instances.map((e) => e.url)).toEqual([`${BASE}/stream?after=2`]);
    act(() => FakeEventSource.instances[0]?.emit("event", userMsg(3, "more")));
    expect(seqs(qc.getQueryData<ConversationEvent[]>(eventsQuery("o1", "c1").queryKey))).toEqual([
      1, 2, 3,
    ]);
    expect(view.getByTestId("seqs").textContent).toBe("1,2,3");
  });

  it("returning within 30 s with no new event reads nothing but the stream", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls = stubApi({});
    const qc = cached();
    mount(qc).unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    const invalidated = sideKeys(qc);
    mount(qc);
    act(() => FakeEventSource.instances[1]?.emit("open"));
    expect(FakeEventSource.instances.map((e) => e.url)).toEqual([
      `${BASE}/stream?after=2`,
      `${BASE}/stream?after=2`,
    ]);
    expect(calls).toEqual([]);
    expect(invalidated()).toEqual([]);
  });

  it("a catch-up that delivers an event invalidates the side keys, once per open", async () => {
    stubApi({});
    const qc = cached();
    const invalidated = sideKeys(qc);
    mount(qc);
    const es = FakeEventSource.instances[0] as FakeEventSource;
    act(() => {
      es.emit("open");
      es.emit("event", userMsg(3, "while away"));
      es.emit("event", userMsg(4, "and more"));
    });
    const side = CONVERSATION_SIDE_KEYS("o1", "c1").map((k) => JSON.stringify(k));
    expect(invalidated()).toEqual(side);
  });

  it("a changed frame for files invalidates only files", async () => {
    stubApi({});
    const qc = cached();
    const invalidated = sideKeys(qc);
    mount(qc);
    act(() => FakeEventSource.instances[0]?.emit("changed", { what: "files" }));
    expect(invalidated()).toEqual([JSON.stringify(keys.org("o1").conversation("c1").files())]);
  });

  it("a stream given up reopens after what it delivered, not after a sent message's seq", async () => {
    stubApi({ [`GET ${BASE}`]: () => new Response(JSON.stringify(CONV("c1"))) });
    const qc = cached();
    mount(qc);
    const es = FakeEventSource.instances[0] as FakeEventSource;
    act(() => es.emit("event", ev(3, "model_call", { step: 0, provider: "p", model: "m" })));
    // a send's answer lands in the log before the stream delivers 4..8
    act(() => void appendEvents(qc, "o1", "c1", [userMsg(9, "sent")]));
    act(() => es.giveUp());
    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    expect(FakeEventSource.instances[1]?.url).toBe(`${BASE}/stream?after=3`);
  });
});
