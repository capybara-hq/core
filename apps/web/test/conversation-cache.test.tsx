// The conversation page through the query cache (web query cache spec §6): the stream appends to
// the cached log, `changed` frames invalidate their key, and a return reads only what changed.
import { type DehydratedState, hashKey, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import ChatPage from "../src/app/(app)/chat/[conversationId]/page";
import { useConversation } from "../src/components/conversation/useConversation";
import { HydrateCache } from "../src/components/HydrateCache";
import type { ConversationEvent } from "../src/lib/conversations";
import {
  appendEvents,
  CONVERSATION_SIDE_KEYS,
  eventsQuery,
  toolInfoQuery,
} from "../src/lib/query/conversation";
import { keys } from "../src/lib/query/keys";
import { type Call, json, noContent, stubApi } from "./support/api";
import {
  CONV,
  ev,
  FakeEventSource,
  renderChatRoute,
  snapshotDefaults,
  userMsg,
} from "./support/conversation";
import { resetNavigation } from "./support/navigation";
import { renderRouteEmptyCache, testQueryClient } from "./support/query";
import { pageElement } from "./support/render";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));

beforeEach(() => {
  resetNavigation("/chat/c1");
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

describe("a later hydration of a log the stream appended to", () => {
  const key = eventsQuery("o1", "c1").queryKey;
  /** A server render's state holding `seqs` for c1's log, read after the cached one. */
  const later = (seqs: number[]): DehydratedState => ({
    mutations: [],
    queries: [
      {
        queryKey: key,
        queryHash: hashKey(key),
        dehydratedAt: Date.now() + 60_000,
        state: {
          data: seqs.map(msg),
          dataUpdateCount: 1,
          dataUpdatedAt: Date.now() + 60_000,
          error: null,
          errorUpdateCount: 0,
          errorUpdatedAt: 0,
          fetchFailureCount: 0,
          fetchFailureReason: null,
          fetchMeta: null,
          isInvalidated: false,
          status: "success",
          fetchStatus: "idle",
        },
      },
    ],
  });
  const hydrateInto = async (qc: ReturnType<typeof testQueryClient>, state: DehydratedState) => {
    const view = render(
      <QueryClientProvider client={qc}>
        <HydrateCache state={state}>
          <p>page</p>
        </HydrateCache>
      </QueryClientProvider>,
    );
    await act(() => new Promise((r) => setTimeout(r, 20)));
    view.unmount();
  };

  it("an older server list never drops what the stream appended", async () => {
    const qc = testQueryClient();
    qc.setQueryData(key, [1, 2, 3, 4, 5].map(msg));
    await hydrateInto(qc, later([1, 2, 3]));
    expect(seqs(qc.getQueryData<ConversationEvent[]>(key))).toEqual([1, 2, 3, 4, 5]);
  });

  it("a longer server list adds its new events", async () => {
    const qc = testQueryClient();
    qc.setQueryData(key, [1, 2, 3, 4, 5].map(msg));
    await hydrateInto(qc, later([1, 2, 3, 4, 5, 6]));
    expect(seqs(qc.getQueryData<ConversationEvent[]>(key))).toEqual([1, 2, 3, 4, 5, 6]);
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
  /** The latest render's state (to send from a test). */
  let latest: ReturnType<typeof useConversation> | undefined;
  function Probe() {
    const c = useConversation("o1", "c1");
    latest = c;
    return (
      <>
        <p data-testid="seqs">{c.events.map((e) => e.seq).join(",")}</p>
        <p data-testid="title">{c.conversation?.title ?? "untitled"}</p>
      </>
    );
  }
  /** A client holding c1's row (`title`) and its log `[1, 2]`, as a first load leaves it. */
  function cached(title: string | null = "Kept") {
    const qc = testQueryClient();
    qc.setQueryData(eventsQuery("o1", "c1").queryKey, [userMsg(1, "hi"), userMsg(2, "there")]);
    qc.setQueryData(keys.org("o1").conversation("c1").row(), CONV("c1", { title }).conversation);
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

  it("returning to a named conversation within 30 s with no new event reads nothing but the stream", async () => {
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

  it("a title generated before the stream opened appears without a navigation, in the sidebar too", async () => {
    const calls = stubApi({
      [`GET ${BASE}`]: () => json(200, CONV("c1", { title: "Generated early" })),
    });
    const qc = cached(null);
    const invalidated = sideKeys(qc);
    const view = mount(qc);
    expect(view.getByTestId("title").textContent).toBe("untitled");
    // generated (and its `changed: title` sent) before the stream was open
    act(() => FakeEventSource.instances[0]?.emit("open"));
    await vi.waitFor(() => expect(view.getByTestId("title").textContent).toBe("Generated early"));
    // the sidebar's groups missed the frame as well: they are read again
    await vi.waitFor(() =>
      expect(invalidated()).toContainEqual(
        JSON.stringify(keys.org("o1").conversationGroupsAll()),
      ),
    );
    // once per mount: a reconnect of the same page reads nothing more
    act(() => FakeEventSource.instances[0]?.emit("open"));
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(calls.map((c) => c.url)).toEqual([BASE]);
  });

  it("a person's own send after an idle open is no catch-up: no side keys are read", async () => {
    stubApi({ [`POST ${BASE}/messages`]: () => json(202, { event: userMsg(3, "mine") }) });
    const qc = cached();
    const invalidated = sideKeys(qc);
    mount(qc);
    const es = FakeEventSource.instances[0] as FakeEventSource;
    act(() => es.emit("open"));
    await act(async () => {
      await latest?.send({ text: "mine", clientMessageId: "m1" });
    });
    act(() => {
      es.emit("event", userMsg(3, "mine"));
      es.emit("event", ev(4, "run_started", { agentVersion: 1, model: null }, "r1"));
    });
    // (the run starting tells the sidebar; nothing outside the log is read)
    const side = new Set(CONVERSATION_SIDE_KEYS("o1", "c1").map((k) => JSON.stringify(k)));
    expect(invalidated().filter((k) => side.has(k))).toEqual([]);
  });

  it("a return after the log was dropped (gc) resumes after the log read whole, not the old point", async () => {
    const all = [1, 2, 3, 4, 5].map((n) => userMsg(n, `m${n}`));
    stubApi({ [`GET ${BASE}/events`]: () => json(200, { events: all }) });
    const qc = cached();
    const first = mount(qc);
    act(() => FakeEventSource.instances[0]?.emit("event", userMsg(3, "m3")));
    first.unmount();
    qc.removeQueries({ queryKey: eventsQuery("o1", "c1").queryKey });
    const again = mount(qc);
    await vi.waitFor(() => expect(again.getByTestId("seqs").textContent).toBe("1,2,3,4,5"));
    expect(FakeEventSource.instances.at(-1)?.url).toBe(`${BASE}/stream?after=5`);
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

describe("the conversation page from the cache", () => {
  const BASE = "/api/v1/orgs/o1/conversations/c1";
  const gets = (calls: Call[]) =>
    calls.filter((c) => c.method === "GET").map((c) => c.url.split("?")[0]);
  const settle = () => act(() => new Promise((r) => setTimeout(r, 20)));
  /** The page's reads, answered as {@link snapshotDefaults} does, with c1's log `[1]`. */
  const routes = (extra: Record<string, (c: Call) => Response> = {}) => ({
    ...snapshotDefaults("c1"),
    [`GET ${BASE}`]: () => json(200, CONV("c1", { title: "Kept" })),
    [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi")] }),
    ...extra,
  });

  it("chat page: a first render from the hydrated cache makes no browser read", async () => {
    const calls = stubApi({});
    await renderChatRoute({ routes: routes() });
    expect(screen.getByText("hi")).toBeTruthy();
    await settle();
    expect(calls).toEqual([]);
    expect(document.querySelector("[aria-busy='true']")).toBeNull();
  });

  it("chat page: an empty cache shows the template's loading state, then the data", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    await renderRouteEmptyCache("/chat/c1", {
      ...routes(),
      [`GET ${BASE}/events`]: async () => {
        await held;
        return json(200, { events: [userMsg(1, "hi")] });
      },
    });
    // the gate's `/me` and readiness are cached on a client navigation; here they load first
    const page = await vi.waitFor(() => {
      const el = document.querySelector('[data-template="ConversationPage"]');
      if (el === null) throw new Error("no page yet");
      return el as HTMLElement;
    });
    expect(page.querySelector("[aria-busy='true']")).not.toBeNull();
    // the composer is real while the thread loads: it can be typed in, not sent from
    const box = screen.getByRole("textbox", { name: en.chat.inputLabel, hidden: true });
    await userEvent.setup().type(box, "early");
    const send = screen.getByRole("button", { name: en.chat.send, hidden: true });
    expect(send).toHaveProperty("disabled", true);
    expect(screen.queryByText("hi")).toBeNull();
    await act(async () => release());
    expect(await screen.findByText("hi")).toBeTruthy();
    await vi.waitFor(() => expect(page.querySelector("[aria-busy='true']")).toBeNull());
    // the draft stayed and can be sent now
    expect(box).toHaveProperty("value", "early");
    expect(screen.getByRole("button", { name: en.chat.send, hidden: true })).toHaveProperty(
      "disabled",
      false,
    );
  });

  it("returning within 30 s with no new event reads only the stream", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls = stubApi({});
    const view = await renderChatRoute({ routes: routes() });
    expect(FakeEventSource.instances.map((e) => e.url)).toEqual([`${BASE}/stream?after=1`]);
    const page = await ChatPage({ params: Promise.resolve({ conversationId: "c1" }) });
    // away (another page), then back at +10 s
    view.rerender(pageElement(<p>elsewhere</p>, { locale: "en" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    view.rerender(pageElement(page, { locale: "en" }));
    expect(await screen.findByText("hi")).toBeTruthy();
    act(() => FakeEventSource.instances[1]?.emit("open"));
    await settle();
    expect(FakeEventSource.instances.map((e) => e.url)).toEqual([
      `${BASE}/stream?after=1`,
      `${BASE}/stream?after=1`,
    ]);
    expect(calls).toEqual([]);
  });

  it("returning with a new event refetches the side pieces", async () => {
    window.history.replaceState(null, "", "/chat/c1#properties");
    const calls = stubApi(routes());
    const view = await renderChatRoute({ routes: routes() });
    const page = await ChatPage({ params: Promise.resolve({ conversationId: "c1" }) });
    view.rerender(pageElement(<p>elsewhere</p>, { locale: "en" }));
    view.rerender(pageElement(page, { locale: "en" }));
    await screen.findByText("hi");
    const es = FakeEventSource.instances[1] as FakeEventSource;
    act(() => {
      es.emit("open");
      es.emit("event", userMsg(2, "while away"));
    });
    expect(await screen.findByText("while away")).toBeTruthy();
    await vi.waitFor(() =>
      expect(gets(calls).sort()).toEqual(
        [BASE, `${BASE}/files`, `${BASE}/queue`, `${BASE}/sandbox`].sort(),
      ),
    );
    window.history.replaceState(null, "", "/");
  });

  it("a changed frame for files reads only the files", async () => {
    const calls = stubApi(routes());
    await renderChatRoute({ routes: routes() });
    act(() => FakeEventSource.instances[0]?.emit("changed", { what: "files" }));
    await vi.waitFor(() => expect(gets(calls)).toEqual([`${BASE}/files`]));
    await settle();
    expect(gets(calls)).toEqual([`${BASE}/files`]);
  });

  it("deleting a queued message invalidates the queue", async () => {
    const queued = {
      id: "q1",
      text: "queued",
      files: [],
      attachments: [],
      clientMessageId: "x",
      createdAt: "2026-10-26T06:00:00.000Z",
      position: 1,
    };
    let items = [queued];
    const extra = {
      [`GET ${BASE}/queue`]: () => json(200, { items, paused: false }),
      [`DELETE ${BASE}/queue/q1`]: () => {
        items = [];
        return noContent();
      },
    };
    const calls = stubApi(routes(extra));
    await renderChatRoute({ routes: routes(extra) });
    expect(await screen.findByText("queued")).toBeTruthy();
    act(() => {
      (
        document.querySelector('[data-queue-item="q1"] [aria-label="Delete"]') as HTMLElement
      )?.click();
    });
    await vi.waitFor(() => expect(gets(calls)).toEqual([`${BASE}/queue`]));
    await vi.waitFor(() => expect(screen.queryByText("queued")).toBeNull());
  });
});
