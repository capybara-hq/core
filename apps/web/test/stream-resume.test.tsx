// Background stream loss (mobile layout spec §7.6): a phone suspends a background page and drops
// its EventSource. Back in the foreground (`visibilitychange` to visible, `pageshow`, `online`)
// a closed stream reopens from the cached last seq and the `live` reads (inbox, conversation
// groups, files) are read again; an open stream is left alone.
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import { useConversation } from "../src/components/conversation/useConversation";
import type { ConversationEvent } from "../src/lib/conversations";
import { type EventWindow, eventsQuery } from "../src/lib/query/conversation";
import { keys } from "../src/lib/query/keys";
import { onForeground } from "../src/lib/stream";
import { json, stubApi } from "./support/api";
import { CONV, FakeEventSource, userMsg } from "./support/conversation";
import { resetNavigation } from "./support/navigation";
import { testQueryClient } from "./support/query";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));

const BASE = "/api/v1/orgs/o1/conversations/c1";
let visibility: DocumentVisibilityState = "visible";

beforeEach(() => {
  resetNavigation("/chat/c1");
  vi.stubGlobal("EventSource", FakeEventSource);
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  FakeEventSource.instances = [];
});

const win = (events: ConversationEvent[]): EventWindow => ({ events, turnsBefore: 0 });

function Probe() {
  const c = useConversation("o1", "c1");
  return <p data-testid="error">{c.error ?? ""}</p>;
}
function cached() {
  const qc = testQueryClient();
  qc.setQueryData(eventsQuery("o1", "c1").queryKey, win([userMsg(1, "hi"), userMsg(2, "there")]));
  qc.setQueryData(
    keys.org("o1").conversation("c1").row(),
    CONV("c1", { title: "Kept" }).conversation,
  );
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
const invalidated = (qc: ReturnType<typeof testQueryClient>) => {
  const spy = vi.spyOn(qc, "invalidateQueries");
  return () => spy.mock.calls.map(([f]) => JSON.stringify(f?.queryKey));
};
const LIVE = [
  keys.org("o1").inbox(),
  keys.org("o1").inboxCount(),
  keys.org("o1").conversationGroupsAll(),
  keys.org("o1").conversation("c1").files(),
].map((k) => JSON.stringify(k));

const becomeVisible = () => {
  visibility = "visible";
  document.dispatchEvent(new Event("visibilitychange"));
};

describe("onForeground", () => {
  it("fires on visibilitychange to visible, pageshow and online; not while hidden; unsubscribes", () => {
    const seen = vi.fn();
    const off = onForeground(seen);
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(seen).not.toHaveBeenCalled();
    becomeVisible();
    window.dispatchEvent(new Event("pageshow"));
    window.dispatchEvent(new Event("online"));
    expect(seen).toHaveBeenCalledTimes(3);
    off();
    becomeVisible();
    window.dispatchEvent(new Event("online"));
    expect(seen).toHaveBeenCalledTimes(3);
  });
});

describe("the conversation stream back in the foreground", () => {
  it("a closed stream reopens from the cached last seq and the live reads go stale", () => {
    stubApi({});
    const qc = cached();
    mount(qc);
    const es = FakeEventSource.instances[0] as FakeEventSource;
    act(() => {
      es.emit("open");
      es.emit("event", userMsg(3, "before the phone slept"));
    });
    const calls = invalidated(qc);
    // suspended in the background: the browser dropped the connection without telling anyone
    es.readyState = 2;
    act(becomeVisible);
    expect(FakeEventSource.instances.map((e) => e.url)).toEqual([
      `${BASE}/stream?after=2`,
      `${BASE}/stream?after=3`,
    ]);
    for (const k of LIVE) expect(calls()).toContain(k);
  });

  it("an open stream is left alone", () => {
    stubApi({});
    const qc = cached();
    mount(qc);
    act(() => FakeEventSource.instances[0]?.emit("open"));
    const calls = invalidated(qc);
    act(() => {
      becomeVisible();
      window.dispatchEvent(new Event("pageshow"));
      window.dispatchEvent(new Event("online"));
    });
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(calls()).toEqual([]);
  });

  it("a stream given up for lost in the background reopens on online and the error goes", async () => {
    stubApi({ [`GET ${BASE}`]: () => json(200, CONV("c1", { title: "Kept" })) });
    const qc = cached();
    mount(qc);
    // four give-ups in a row with no open between them: the page says the stream is lost
    for (let i = 1; i <= 4; i++) {
      const s = FakeEventSource.instances[i - 1] as FakeEventSource;
      act(() => s.giveUp());
      if (i < 4) await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(i + 1));
    }
    await vi.waitFor(() =>
      expect(screen.getByTestId("error").textContent).toBe(en.chat.streamLost),
    );
    act(() => window.dispatchEvent(new Event("online")));
    expect(FakeEventSource.instances).toHaveLength(5);
    expect(FakeEventSource.instances[4]?.url).toBe(`${BASE}/stream?after=2`);
    expect(screen.getByTestId("error").textContent).toBe("");
  });

  it("a stream stopped by the server (an error frame) stays stopped", () => {
    stubApi({});
    const qc = cached();
    mount(qc);
    const es = FakeEventSource.instances[0] as FakeEventSource;
    act(() => es.emit("error", { code: "auth.session_revoked" }));
    act(becomeVisible);
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("after unmount nothing reopens", () => {
    stubApi({});
    const qc = cached();
    const view = mount(qc);
    view.unmount();
    act(becomeVisible);
    expect(FakeEventSource.instances).toHaveLength(1);
  });
});
