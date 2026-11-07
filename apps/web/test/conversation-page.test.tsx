import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import ChatPage from "../src/app/(app)/chat/[conversationId]/page";
import { navigateBrowser } from "../src/lib/browser";
import { keys } from "../src/lib/query/keys";
import { bodyOf, type Call, json, lastStubRoutes, stubApi } from "./support/api";
import {
  AGENTS,
  CONV,
  ev,
  FakeEventSource,
  LIMITS,
  MODELS,
  renderChatRoute,
  runStarted,
  snapshotDefaults,
  userMsg,
} from "./support/conversation";
import { resetNavigation, router } from "./support/navigation";
import { renderRouteEmptyCache, renderRouteWithCache } from "./support/query";
import { currentPageClient, ME, pageElement } from "./support/render";
import { expectNoFirstPaintFetch, onServer } from "./support/server";
import { renderFrame, shellOf } from "./support/shell";

const params = { conversationId: "c1" };
const search = new URLSearchParams();
vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("../src/lib/browser", () => ({ navigateBrowser: vi.fn() }));
vi.mock("next/navigation", () => ({
  useParams: () => params,
  useSearchParams: () => search,
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

const BASE = "/api/v1/orgs/o1/conversations/c1";

/** The page's background reads, plus `extra`. */
function api(extra: Record<string, (c: Call) => Response | Promise<Response>>, id = "c1") {
  const base = `/api/v1/orgs/o1/conversations/${id}`;
  return stubApi({
    [`GET ${base}`]: () => json(200, CONV(id)),
    "GET /api/v1/orgs/o1/agents": () => json(200, AGENTS),
    "GET /api/v1/orgs/o1/models": () => json(200, MODELS),
    [`GET ${base}/queue`]: () => json(200, { items: [], paused: false }),
    [`GET ${base}/tools`]: () => json(200, { tools: [] }),
    [`GET ${base}/files`]: () => json(200, { files: [], next: null }),
    "GET /api/v1/orgs/o1/ui/contributions": () => json(200, { items: [] }),
    "GET /api/v1/orgs/o1/attachments/limits": () => json(200, LIMITS),
    ...extra,
  });
}

const renderChat = (locale: "zh" | "en" = "en") => renderChatRoute({ locale });

/**
 * Counts the page's invalidations of the sidebar's conversation groups (the sidebar reads them
 * again), from now on.
 */
function sidebarRefreshes() {
  const spy = vi.spyOn(currentPageClient(), "invalidateQueries");
  const groups = JSON.stringify(keys.org("o1").conversationGroupsAll());
  return () => spy.mock.calls.filter(([f]) => JSON.stringify(f?.queryKey) === groups).length;
}
const input = (m = en) => screen.getByRole("textbox", { name: m.chat.inputLabel, hidden: true });
const posts = (calls: Call[], path: string) =>
  calls.filter((c) => c.method === "POST" && c.url.split("?")[0] === path);

beforeEach(() => {
  vi.mocked(navigateBrowser).mockReset();
  params.conversationId = "c1";
  for (const k of [...search.keys()]) search.delete(k);
  resetNavigation("/chat/c1");
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  FakeEventSource.instances = [];
});

describe("the conversation page (ConversationPage)", () => {
  it("renders the template with the untitled placeholder, the status bar and the thread", async () => {
    const calls = api({
      [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi"), runStarted(2)] }),
    });
    const { container, calls: server } = await renderChat("zh");
    // the first paint is the server's snapshot: the browser reads nothing, the stream opens at 2
    expect(calls).toEqual([]);
    expect(server.map((c) => c.url)).toEqual(
      expect.arrayContaining([BASE, `${BASE}/events?after=0&limit=500`, `${BASE}/queue`]),
    );
    expect(FakeEventSource.instances.map((e) => e.url)).toEqual([`${BASE}/stream?after=2`]);
    expect(container.querySelector('[data-template="ConversationPage"]')).not.toBeNull();
    expect(screen.getByText("hi")).toBeTruthy();
    expect(screen.getByText(/^未命名会话 · /)).toBeTruthy();
    expect(screen.getByText(zh.chat.status.running)).toBeTruthy();
    expect(screen.getByText(/第 1 轮 · 已用/)).toBeTruthy();
    expect(screen.getByText("hi").closest("[data-entry]")?.getAttribute("data-entry")).toBe("user");
  });

  it("the title bar path is <org slug> / <agent> / before the title; the agent links to its page with its avatar", async () => {
    api({ [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi")] }) });
    const { container } = await renderChat("en");
    await screen.findByText("hi");
    const bar = container.querySelector('[data-part="title-bar"]') as HTMLElement;
    const nav = await within(bar).findByRole("navigation", { name: "Path" });
    const link = await within(nav).findByRole("link", { name: "Echo agent" });
    expect(link.getAttribute("href")).toBe("/agents/ag1");
    // the agent's avatar (16) leads its segment: an agent without one shows its initial
    const avatar = link.querySelector('[data-part="avatar"]') as HTMLElement;
    expect(avatar.getAttribute("data-size")).toBe("16");
    expect(avatar.textContent).toBe("E");
    avatar.remove();
    expect(nav.textContent).toBe("acme/Echo agent/");
  });

  it("the composer's toolbar names no agent: the title bar's path does (issue U)", async () => {
    api({ [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi")] }) });
    const { container } = await renderChat("en");
    await screen.findByText("hi");
    await screen.findByRole("button", { name: `${en.chat.pickModel}: Fake 1` });
    const bar = container.querySelector('[data-part="composer"]') as HTMLElement;
    expect(bar).not.toBeNull();
    expect(bar.querySelector('[data-locked="true"]')).toBeNull();
    expect(bar.textContent).not.toContain("Echo agent");
  });

  it("the status bar signs like every page: <login>@<slug>:~/chat/<id>, then version and time zone", async () => {
    params.conversationId = "9f60c1e6-1111-4222-8333-444455556666";
    const id = params.conversationId;
    api(
      { [`GET /api/v1/orgs/o1/conversations/${id}/events`]: () => json(200, { events: [] }) },
      id,
    );
    const { container } = await renderChatRoute({
      id,
      locale: "en",
      session: { version: "v9.9.9", timeZone: "UTC+8" },
    });
    const bar = container.querySelector('[data-part="status-bar"]') as HTMLElement;
    expect((bar.querySelector('[data-part="status-bar-context"]') as HTMLElement).textContent).toBe(
      "grant@acme:~/chat/9f60c1e6",
    );
    expect(bar.textContent).toMatch(/v9\.9\.9.*UTC\+8/);
    params.conversationId = "c1";
  });

  it("a failed last run reads in fail in the status bar", async () => {
    api({
      [`GET ${BASE}/events`]: () =>
        json(200, {
          events: [
            userMsg(1, "hello"),
            runStarted(2),
            ev(3, "run_failed", { error: { code: "model.timeout", message: "x" } }),
          ],
        }),
    });
    const { container } = await renderChat("en");
    await screen.findByText("hello");
    const bar = container.querySelector('[data-part="status-bar"]') as HTMLElement;
    const failed = within(bar).getByText(en.chat.status.failed);
    expect(failed.getAttribute("data-tone")).toBe("fail");
  });

  it("the composer is a sibling of the scrolling thread, not inside it", async () => {
    api({ [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi")] }) });
    const { container } = await renderChat("en");
    await screen.findByText("hi");
    const scroll = container.querySelector(".cb-conv-scroll") as HTMLElement;
    const slot = container.querySelector(".cb-conv-composer") as HTMLElement;
    expect(slot.parentElement).toBe(scroll.parentElement);
    expect(scroll.contains(slot)).toBe(false);
    expect(scroll.contains(input())).toBe(false);
    expect(slot.contains(input())).toBe(true);
  });

  it.each(["zh", "en"] as const)(
    "while running, Stop calls abort; the input stays enabled; a stopped run row follows (%s)",
    async (locale) => {
      const m = locale === "zh" ? zh : en;
      const calls = api({
        [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi"), runStarted(2)] }),
        [`POST ${BASE}/abort`]: () => json(202, { runId: "r1" }),
      });
      await renderChat(locale);
      const stop = await screen.findByRole("button", { name: m.chat.stop });
      expect(FakeEventSource.instances[0]?.url).toBe(`${BASE}/stream?after=2`);
      expect(input(m)).toHaveProperty("disabled", false);
      await userEvent.setup().click(stop);
      expect(posts(calls, `${BASE}/abort`)[0]?.headers.get("x-capybara-csrf")).toBe("1");
      act(() => {
        FakeEventSource.instances[0]?.emit(
          "event",
          ev(3, "run_aborted", { byAccountId: "a1", reason: "user" }),
        );
      });
      expect(screen.queryByRole("button", { name: m.chat.stop })).toBeNull();
      expect(document.querySelector('[data-run-status="stopped"]')?.textContent).toContain(
        m.chat.you,
      );
    },
  );

  it("a stop whose request fails says so inline, once, and logs the browser's reason (AC5)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    api({
      [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi"), runStarted(2)] }),
      [`POST ${BASE}/abort`]: () => {
        throw new TypeError("Load failed");
      },
    });
    await renderChat("en");
    await userEvent.setup().click(await screen.findByRole("button", { name: en.chat.stop }));
    expect(
      await screen.findByText(
        "Couldn't stop: Cannot reach the server. Check your network connection.",
      ),
    ).toBeTruthy();
    expect(String(warn.mock.calls[0]?.[2])).toContain("Load failed");
    // the run still shows as running: Stop can be pressed again
    expect(screen.getByRole("button", { name: en.chat.stop })).toHaveProperty("disabled", false);
    warn.mockRestore();
  });

  it("a stop the kernel took stays under way until the run's end arrives (AC5)", async () => {
    api({
      [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi"), runStarted(2)] }),
      [`POST ${BASE}/abort`]: () => json(202, { runId: "r1" }),
    });
    await renderChat("en");
    await userEvent.setup().click(await screen.findByRole("button", { name: en.chat.stop }));
    // the HTTP answer is in: the stop is still under way (disabled), not pressable again
    await act(async () => await new Promise((r) => setTimeout(r, 20)));
    expect(screen.getByRole("button", { name: en.chat.stop })).toHaveProperty("disabled", true);
    act(() => {
      FakeEventSource.instances[0]?.emit(
        "event",
        ev(3, "run_aborted", { byAccountId: "a1", reason: "user" }),
      );
    });
    expect(screen.queryByRole("button", { name: en.chat.stop })).toBeNull();
  });

  it("a stop answered run.not_active reads the log again, so a stale Stop goes (AC5)", async () => {
    let reads = 0;
    const calls = api({
      [`GET ${BASE}/events`]: () =>
        json(200, {
          events:
            reads++ === 0
              ? [userMsg(1, "hi"), runStarted(2)]
              : [
                  userMsg(1, "hi"),
                  runStarted(2),
                  ev(3, "run_finished", { reason: "completed", consumedUpToSeq: 1 }),
                ],
        }),
      [`POST ${BASE}/abort`]: () =>
        json(409, { error: { code: "run.not_active", message: "no active run" } }),
    });
    await renderChat("en");
    await userEvent.setup().click(await screen.findByRole("button", { name: en.chat.stop }));
    await waitFor(() => expect(screen.queryByRole("button", { name: en.chat.stop })).toBeNull());
    // the server's first read, then the client's read from the cached end after the 409
    expect(reads).toBe(2);
    expect(calls.some((c) => c.method === "GET" && c.url.includes("/events?after=2"))).toBe(true);
    expect(calls.some((c) => c.method === "GET" && c.url.startsWith(`${BASE}/events`))).toBe(true);
    expect(screen.queryByText(/Couldn't stop/)).toBeNull();
  });

  it("a run another member stopped names them; an unknown account reads another member (m8)", async () => {
    const stopped = (seq: number, by: string, run: string) => [
      ev(seq, "run_started", { agentVersion: 1, model: { provider: "p", model: "m" } }, run),
      ev(seq + 1, "run_aborted", { byAccountId: by, reason: "user" }, run),
    ];
    api({
      [`GET ${BASE}/events`]: () =>
        json(200, {
          events: [
            userMsg(1, "hi"),
            ...stopped(2, "acc-bo", "r1"),
            ...stopped(4, "acc-gone", "r2"),
          ],
        }),
      "GET /api/v1/orgs/o1/members": () =>
        json(200, {
          members: [
            {
              account: { id: "acc-bo", displayName: "Bo Admin", email: null },
              role: "admin",
              joinedAt: "2026-10-01T00:00:00.000Z",
              anonymous: false,
            },
          ],
        }),
    });
    await renderChat();
    await vi.waitFor(() =>
      expect(document.querySelectorAll('[data-run-status="stopped"]')).toHaveLength(2),
    );
    const dividers = () =>
      [...document.querySelectorAll('[data-run-status="stopped"]')].map((d) => d.textContent ?? "");
    await vi.waitFor(() => expect(dividers()[0]).toContain("Bo Admin"));
    expect(dividers()[1]).toContain(en.chat.anotherMember);
    expect(dividers().join(" ")).not.toContain("acc-");
  });

  it("streams deltas with a cursor; the assistant_message replaces the draft", async () => {
    api({ [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi"), runStarted(2)] }) });
    await renderChat();
    await screen.findByRole("button", { name: en.chat.stop });
    const es = FakeEventSource.instances[0] as FakeEventSource;
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal("cancelAnimationFrame", () => {});
    act(() => {
      es.emit("delta", { runId: "r1", step: 0, delta: "text", text: "hel" });
      es.emit("delta", { runId: "r1", step: 0, delta: "text", text: "lo" });
    });
    // deltas are applied once per animation frame, together (final review I3)
    expect(screen.queryByText("hello")).toBeNull();
    expect(frames).toHaveLength(1);
    act(() => {
      for (const f of frames.splice(0)) f(0);
    });
    expect(screen.getByText("hello").closest('[data-streaming="true"]')).not.toBeNull();
    // the streaming entry is busy, so the live thread announces it once it settles (I2)
    expect(
      screen.getByText("hello").closest('[data-streaming="true"]')?.getAttribute("aria-busy"),
    ).toBe("true");
    act(() =>
      es.emit(
        "event",
        ev(3, "assistant_message", {
          step: 0,
          content: [{ type: "text", text: "hello world" }],
          stopReason: "end_turn",
        }),
      ),
    );
    expect(screen.queryByText("hello")).toBeNull();
    expect(screen.getByText("hello world")).toBeTruthy();
  });

  it("↵, ⌘↵ and Ctrl+↵ while running all post a message (an interjection); nothing is queued", async () => {
    let n = 2;
    const calls = api({
      [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi"), runStarted(2)] }),
      [`POST ${BASE}/messages`]: (c) =>
        json(202, { event: userMsg(++n, String((bodyOf(c) as { text: string }).text)) }),
    });
    await renderChat();
    await screen.findByRole("button", { name: en.chat.stop });
    expect(input().getAttribute("placeholder")).toBe(en.chat.runningHint);
    const user = userEvent.setup();
    await user.type(input(), "later{Enter}");
    await vi.waitFor(() => expect(posts(calls, `${BASE}/messages`)).toHaveLength(1));
    expect(
      typeof (bodyOf(posts(calls, `${BASE}/messages`)[0]) as { clientMessageId: unknown })
        .clientMessageId,
    ).toBe("string");
    await user.type(input(), "now{Meta>}{Enter}{/Meta}");
    await vi.waitFor(() => expect(posts(calls, `${BASE}/messages`)).toHaveLength(2));
    await user.type(input(), "now2{Control>}{Enter}{/Control}");
    await vi.waitFor(() => expect(posts(calls, `${BASE}/messages`)).toHaveLength(3));
    expect(
      posts(calls, `${BASE}/messages`).map((c) => (bodyOf(c) as { text: string }).text),
    ).toEqual(["later", "now", "now2"]);
    expect(posts(calls, `${BASE}/queue`)).toHaveLength(0);
    // no queue list or its controls
    expect(screen.queryByRole("group", { name: /queue/i })).toBeNull();
    expect(screen.queryByRole("button", { name: "Send now" })).toBeNull();
  });

  it("↵ while running sends the pending model / effort pick with the message and clears it", async () => {
    let n = 2;
    const calls = api({
      [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi"), runStarted(2)] }),
      [`POST ${BASE}/messages`]: (c) =>
        json(202, { event: userMsg(++n, String((bodyOf(c) as { text: string }).text)) }),
    });
    await renderChat();
    await screen.findByRole("button", { name: en.chat.stop });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: `${en.chat.pickModel}: Fake 1` }));
    await user.click(await screen.findByRole("menuitemradio", { name: /Fake 2/ }));
    await user.click(await screen.findByRole("button", { name: `${en.chat.pickEffort}: Low` }));
    await user.click(await screen.findByRole("menuitemradio", { name: /High/ }));
    await user.type(input(), "later{Enter}");
    await vi.waitFor(() => expect(posts(calls, `${BASE}/messages`)).toHaveLength(1));
    expect(bodyOf(posts(calls, `${BASE}/messages`)[0])).toMatchObject({
      text: "later",
      model: { provider: "model-fake", model: "fake-2" },
      effort: "high",
    });
    // the pick went with that message: the next one carries none
    await user.type(input(), "again{Enter}");
    await vi.waitFor(() => expect(posts(calls, `${BASE}/messages`)).toHaveLength(2));
    const body = bodyOf(posts(calls, `${BASE}/messages`)[1]) as Record<string, unknown>;
    expect(body).not.toHaveProperty("model");
    expect(body).not.toHaveProperty("effort");
  });

  it("with no run going ↵ sends and ⌘↵ sends too; nothing is queued", async () => {
    let n = 1;
    const calls = api({
      [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi")] }),
      [`POST ${BASE}/messages`]: (c) =>
        json(202, { event: userMsg(++n, String((bodyOf(c) as { text: string }).text)) }),
    });
    await renderChat();
    await screen.findByText("hi");
    expect(input().getAttribute("placeholder")).toBe(en.chat.placeholder);
    const user = userEvent.setup();
    await user.type(input(), "one{Enter}");
    await vi.waitFor(() => expect(posts(calls, `${BASE}/messages`)).toHaveLength(1));
    await user.type(input(), "two{Meta>}{Enter}{/Meta}");
    await vi.waitFor(() => expect(posts(calls, `${BASE}/messages`)).toHaveLength(2));
    expect(posts(calls, `${BASE}/queue`)).toHaveLength(0);
  });

  it("the running hint says a message reaches the agent at its next step, in both languages", () => {
    expect(zh.chat.runningHint).toBe("运行中发送的消息会在下一步交给智能体");
    expect(en.chat.runningHint).toBe("Messages sent while it works reach it at its next step");
  });

  describe("instant send (conversation send spec §2.1)", () => {
    /** The user bubbles of `text`, pending or from the log. */
    const bubbles = (text: string) =>
      screen.queryAllByText(text, { selector: '[data-part="bubble-body"]' });

    function deferredSend() {
      let answer: (r: Response) => void = () => {};
      let cmid = "";
      const calls = api({
        [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi")] }),
        [`POST ${BASE}/messages`]: (c) => {
          cmid = (bodyOf(c) as { clientMessageId: string }).clientMessageId;
          return new Promise<Response>((r) => {
            answer = r;
          });
        },
      });
      return { calls, answer: (r: Response) => answer(r), cmid: () => cmid };
    }

    it("clears the composer and shows a pending bubble in the same tick as ↵", async () => {
      const d = deferredSend();
      await renderChat();
      await screen.findByText("hi");
      fireEvent.change(input(), { target: { value: "next" } });
      fireEvent.keyDown(input(), { key: "Enter" });
      // no await: the same tick
      expect(input()).toHaveProperty("value", "");
      const pending = bubbles("next");
      expect(pending).toHaveLength(1);
      expect(pending[0]?.closest("[data-pending]")).not.toBeNull();
      await vi.waitFor(() => expect(posts(d.calls, `${BASE}/messages`)).toHaveLength(1));
    });

    it("the stream's user_message replaces the pending bubble: the text shows once", async () => {
      const d = deferredSend();
      await renderChat();
      await screen.findByText("hi");
      const user = userEvent.setup();
      await user.type(input(), "next{Enter}");
      await vi.waitFor(() => expect(posts(d.calls, `${BASE}/messages`)).toHaveLength(1));
      const event = userMsg(2, "next", { clientMessageId: d.cmid() });
      act(() => FakeEventSource.instances[0]?.emit("event", event));
      expect(bubbles("next")).toHaveLength(1);
      expect(bubbles("next")[0]?.closest("[data-pending]")).toBeNull();
      expect(bubbles("next")[0]?.closest("[data-entry]")?.getAttribute("data-entry")).toBe("user");
      await act(async () => d.answer(json(202, { event })));
      expect(bubbles("next")).toHaveLength(1);
    });

    it("the POST's answer replaces the pending bubble when it comes first", async () => {
      const d = deferredSend();
      await renderChat();
      await screen.findByText("hi");
      const user = userEvent.setup();
      await user.type(input(), "next{Enter}");
      await vi.waitFor(() => expect(posts(d.calls, `${BASE}/messages`)).toHaveLength(1));
      const event = userMsg(2, "next", { clientMessageId: d.cmid() });
      await act(async () => d.answer(json(202, { event })));
      await vi.waitFor(() => expect(bubbles("next")[0]?.closest("[data-pending]")).toBeNull());
      expect(bubbles("next")).toHaveLength(1);
      act(() => FakeEventSource.instances[0]?.emit("event", event));
      expect(bubbles("next")).toHaveLength(1);
    });

    it("the working line shows from the send until the first output, again after a tool result, and goes at the run's end", async () => {
      const d = deferredSend();
      const { container } = await renderChat();
      await screen.findByText("hi");
      const line = () => container.querySelector('[data-part="working-line"]');
      // an old message without a run, not sent from this tab: no line
      expect(line()).toBeNull();
      act(() => FakeEventSource.instances[0]?.emit("event", runStarted(2)));
      act(() =>
        FakeEventSource.instances[0]?.emit(
          "event",
          ev(3, "run_finished", { reason: "end_turn", consumedUpToSeq: 1 }),
        ),
      );
      expect(line()).toBeNull();
      const user = userEvent.setup();
      await user.type(input(), "next{Enter}");
      expect(line()).not.toBeNull();
      const es = FakeEventSource.instances[0] as FakeEventSource;
      act(() => es.emit("event", userMsg(4, "next", { clientMessageId: d.cmid() })));
      act(() => es.emit("event", runStarted(5, "r2")));
      expect(line()).not.toBeNull();
      // after the line, the thread's last output: exactly one line
      expect(container.querySelectorAll('[data-part="working-line"]')).toHaveLength(1);
      act(() =>
        es.emit(
          "event",
          ev(
            6,
            "assistant_message",
            {
              step: 0,
              stopReason: "tool_use",
              content: [{ type: "tool_call", id: "t1", name: "Bash", input: { command: "ls" } }],
            },
            "r2",
          ),
        ),
      );
      act(() =>
        es.emit(
          "event",
          ev(
            7,
            "tool_call_started",
            { step: 0, callId: "t1", toolKey: "Bash", specHash: "h" },
            "r2",
          ),
        ),
      );
      expect(line()).toBeNull();
      act(() =>
        es.emit(
          "event",
          ev(
            8,
            "tool_result",
            { step: 0, callId: "t1", toolKey: "Bash", content: "ok", isError: false },
            "r2",
          ),
        ),
      );
      expect(line()).not.toBeNull();
      act(() =>
        es.emit("event", ev(9, "run_finished", { reason: "end_turn", consumedUpToSeq: 4 }, "r2")),
      );
      expect(line()).toBeNull();
    });

    it("a second ↵ while the first send waits for its run posts a message too (L1)", async () => {
      let n = 1;
      const calls = api({
        [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi")] }),
        [`POST ${BASE}/messages`]: (c) => {
          const b = bodyOf(c) as { text: string; clientMessageId: string };
          return json(202, { event: userMsg(++n, b.text, { clientMessageId: b.clientMessageId }) });
        },
      });
      await renderChat();
      await screen.findByText("hi");
      const user = userEvent.setup();
      await user.type(input(), "one{Enter}");
      await user.type(input(), "two{Enter}");
      await vi.waitFor(() => expect(posts(calls, `${BASE}/messages`)).toHaveLength(2));
      expect(
        posts(calls, `${BASE}/messages`).map((c) => (bodyOf(c) as { text: string }).text),
      ).toEqual(["one", "two"]);
      expect(posts(calls, `${BASE}/queue`)).toHaveLength(0);
    });

    it("right after a send the composer is in running mode and the status says running (L2)", async () => {
      const d = deferredSend();
      const { container } = await renderChat();
      await screen.findByText("hi");
      const status = () =>
        (container.querySelector('[data-part="status-bar"]') as HTMLElement).textContent ?? "";
      expect(status()).toContain(en.chat.status.idle);
      fireEvent.change(input(), { target: { value: "next" } });
      fireEvent.keyDown(input(), { key: "Enter" });
      expect(screen.getByRole("button", { name: en.chat.stop })).toBeTruthy();
      expect(input().getAttribute("placeholder")).toBe(en.chat.runningHint);
      expect(status()).toContain(en.chat.status.running);
      expect(container.querySelector('[data-part="working-line"]')).not.toBeNull();
      // the log has the message, its run has not started: still running, all three agree
      await vi.waitFor(() => expect(posts(d.calls, `${BASE}/messages`)).toHaveLength(1));
      const event = userMsg(2, "next", { clientMessageId: d.cmid() });
      await act(async () => d.answer(json(202, { event })));
      expect(screen.getByRole("button", { name: en.chat.stop })).toBeTruthy();
      expect(status()).toContain(en.chat.status.running);
      expect(container.querySelector('[data-part="working-line"]')).not.toBeNull();
    });

    it("a paused leftover queue does not hold a message: it waits for its run (run input D1)", async () => {
      api({
        [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi")] }),
        [`GET ${BASE}/queue`]: () => json(200, { items: [], paused: true }),
        [`POST ${BASE}/messages`]: (c) => {
          const b = bodyOf(c) as { text: string; clientMessageId: string };
          return json(202, {
            event: userMsg(2, b.text, { clientMessageId: b.clientMessageId }),
          });
        },
      });
      const { container } = await renderChat();
      await screen.findByText("hi");
      await userEvent.setup().type(input(), "next{Enter}");
      await vi.waitFor(() => expect(container.querySelector("[data-pending]")).toBeNull());
      expect(container.querySelector('[data-part="working-line"]')).not.toBeNull();
      expect(screen.getByRole("button", { name: en.chat.stop })).toBeTruthy();
    });

    it("a run that never starts: the line goes 60 s after this tab's send (the backstop)", async () => {
      api({
        [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi")] }),
        [`POST ${BASE}/messages`]: (c) => {
          const b = bodyOf(c) as { text: string; clientMessageId: string };
          return json(202, { event: userMsg(2, b.text, { clientMessageId: b.clientMessageId }) });
        },
      });
      const { container } = await renderChat();
      await screen.findByText("hi");
      // this tab's clock from here on: the send's time and the backstop's timer
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      try {
        fireEvent.change(input(), { target: { value: "next" } });
        fireEvent.keyDown(input(), { key: "Enter" });
        await vi.waitFor(() => expect(container.querySelector("[data-pending]")).toBeNull());
        expect(container.querySelector('[data-part="working-line"]')).not.toBeNull();
        act(() => vi.advanceTimersByTime(59_000));
        expect(container.querySelector('[data-part="working-line"]')).not.toBeNull();
        // no run_started 60 s after the send: the timer re-renders and the line goes
        act(() => vi.advanceTimersByTime(1_100));
        expect(container.querySelector('[data-part="working-line"]')).toBeNull();
        expect(screen.queryByRole("button", { name: en.chat.stop })).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("a server createdAt 10 minutes in the past still shows the line for a fresh send here", async () => {
      api({
        [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi")] }),
        [`POST ${BASE}/messages`]: (c) => {
          const b = bodyOf(c) as { text: string; clientMessageId: string };
          const at = new Date(Date.now() - 600_000).toISOString();
          return json(202, {
            event: { ...userMsg(2, b.text, { clientMessageId: b.clientMessageId }), createdAt: at },
          });
        },
      });
      const { container } = await renderChat();
      await screen.findByText("hi");
      await userEvent.setup().type(input(), "next{Enter}");
      await vi.waitFor(() => expect(container.querySelector("[data-pending]")).toBeNull());
      expect(container.querySelector('[data-part="working-line"]')).not.toBeNull();
      expect(screen.getByRole("button", { name: en.chat.stop })).toBeTruthy();
    });

    it("a message the kernel wrote but could not deliver shows no line after the error", async () => {
      let cmid = "";
      api({
        [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi")] }),
        [`POST ${BASE}/messages`]: (c) => {
          cmid = (bodyOf(c) as { clientMessageId: string }).clientMessageId;
          return json(503, { error: { code: "upstream_unavailable", message: "queue down" } });
        },
      });
      const { container } = await renderChat();
      await screen.findByText("hi");
      await userEvent.setup().type(input(), "next{Enter}");
      // the stream delivers the written message, the POST fails
      act(() =>
        FakeEventSource.instances[0]?.emit("event", userMsg(2, "next", { clientMessageId: cmid })),
      );
      await vi.waitFor(() => expect(input()).toHaveProperty("value", "next"));
      expect(container.querySelector('[data-part="working-line"]')).toBeNull();
      expect(screen.queryByRole("button", { name: en.chat.stop })).toBeNull();
    });

    it("a failed POST drops the pending bubble and puts the text back", async () => {
      const d = deferredSend();
      await renderChat();
      await screen.findByText("hi");
      const user = userEvent.setup();
      await user.type(input(), "next{Enter}");
      expect(bubbles("next")).toHaveLength(1);
      await act(async () => d.answer(json(500, { error: { code: "internal", message: "boom" } })));
      await vi.waitFor(() => expect(input()).toHaveProperty("value", "next"));
      expect(bubbles("next")).toHaveLength(0);
    });
  });

  it("Shift+↵ is a newline and ↵ during IME composition sends nothing", async () => {
    const calls = api({ [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi")] }) });
    await renderChat();
    await screen.findByText("hi");
    const user = userEvent.setup();
    await user.type(input(), "a{Shift>}{Enter}{/Shift}b");
    expect(input()).toHaveProperty("value", "a\nb");
    fireEvent.keyDown(input(), { key: "Enter", isComposing: true });
    expect(posts(calls, `${BASE}/messages`)).toHaveLength(0);
  });

  it("a failed send keeps the clientMessageId for the retry; a changed draft gets a new one", async () => {
    let fail = 1;
    let seq = 2;
    const calls = api({
      [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi")] }),
      [`POST ${BASE}/messages`]: (c) => {
        if (fail-- > 0) return json(500, { error: { code: "internal", message: "boom" } });
        return json(202, { event: userMsg(++seq, (bodyOf(c) as { text: string }).text) });
      },
    });
    await renderChat();
    await screen.findByText("hi");
    const user = userEvent.setup();
    const send = () => user.click(screen.getByRole("button", { name: en.chat.send }));
    await user.type(input(), "first");
    await send();
    expect(input()).toHaveProperty("value", "first");
    await send();
    await screen.findByText("first");
    await user.type(input(), "second");
    await send();
    await screen.findByText("second");
    const ids = posts(calls, `${BASE}/messages`).map(
      (c) => (bodyOf(c) as { clientMessageId: string }).clientMessageId,
    );
    expect(ids).toHaveLength(3);
    expect(ids[1]).toBe(ids[0]);
    expect(ids[2]).not.toBe(ids[0]);
  });

  it("a server error frame shows the translated error", async () => {
    api({ [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi")] }) });
    await renderChat("zh");
    await screen.findByText("hi");
    act(() => FakeEventSource.instances[0]?.emit("error", { code: "auth.session_revoked" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      `${zh.errors.auth.session_revoked}`,
    );
  });

  it("reconnect: a stream the browser gave up reopens after the last seq it delivered", async () => {
    api({
      [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi"), runStarted(2)] }),
      [`POST ${BASE}/messages`]: () => json(202, { event: userMsg(9, "later") }),
    });
    await renderChat();
    await screen.findByRole("button", { name: en.chat.stop });
    const es = FakeEventSource.instances[0] as FakeEventSource;
    act(() => es.emit("event", ev(3, "model_call", { step: 0, provider: "p", model: "m" })));
    const user = userEvent.setup();
    await user.type(input(), "later{Enter}");
    await screen.findByText("later");
    act(() => es.giveUp());
    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    expect(FakeEventSource.instances[1]?.url).toBe(`${BASE}/stream?after=3`);
    // Every successful open resets the reopen count: an idle conversation never says "lost".
    for (let i = 2; i <= 5; i++) {
      const s = FakeEventSource.instances[i - 1] as FakeEventSource;
      act(() => {
        s.emit("open");
        s.giveUp();
      });
      await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(i + 1));
    }
    expect(screen.queryByText(en.chat.streamLost)).toBeNull();
  });

  it("picking a model sends it with the next message only; a model without effort hides the picker", async () => {
    let seq = 1;
    const calls = api({
      [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi")] }),
      [`POST ${BASE}/messages`]: (c) =>
        json(202, { event: userMsg(++seq, (bodyOf(c) as { text: string }).text) }),
    });
    await renderChat();
    await screen.findByText("hi");
    const user = userEvent.setup();
    // fake-1 declares no effort: no effort picker
    const model = await screen.findByRole("button", { name: `${en.chat.pickModel}: Fake 1` });
    expect(screen.queryByRole("button", { name: new RegExp(`^${en.chat.pickEffort}`) })).toBeNull();
    await user.click(model);
    await user.click(await screen.findByRole("menuitemradio", { name: /Fake 2/ }));
    const effort = await screen.findByRole("button", { name: `${en.chat.pickEffort}: Low` });
    await user.click(effort);
    await user.click(await screen.findByRole("menuitemradio", { name: /High/ }));
    await user.type(input(), "one{Enter}");
    await screen.findByText("one");
    await user.type(input(), "two{Enter}");
    await screen.findByText("two");
    const bodies = posts(calls, `${BASE}/messages`).map(
      (c) => bodyOf(c) as Record<string, unknown>,
    );
    expect(bodies[0]).toMatchObject({
      model: { provider: "model-fake", model: "fake-2" },
      effort: "high",
    });
    expect(bodies[1]).not.toHaveProperty("model");
    expect(bodies[1]).not.toHaveProperty("effort");
  });

  it("rename from the title menu PATCHes and shows the title; changed: title refetches it, the sidebar only for a new title", async () => {
    let title: string | null = null;
    const calls = api({
      [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi")] }),
      [`GET ${BASE}`]: () => json(200, CONV("c1", { title })),
      [`PATCH ${BASE}`]: (c) => {
        title = (bodyOf(c) as { title: string }).title;
        return json(200, CONV("c1", { title, titleSource: "manual" }));
      },
    });
    await renderChat();
    const refreshes = sidebarRefreshes();
    await screen.findByText("hi");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^Untitled conversation/ }));
    await user.click(await screen.findByRole("menuitem", { name: en.chat.rename }));
    const field = await screen.findByRole("textbox", { name: "Title" });
    await user.type(field, "Quarterly numbers{Enter}");
    await vi.waitFor(() => expect(calls.find((c) => c.method === "PATCH")).toBeTruthy());
    expect(bodyOf(calls.find((c) => c.method === "PATCH"))).toEqual({ title: "Quarterly numbers" });
    expect(await screen.findByRole("button", { name: /Quarterly numbers/ })).toBeTruthy();
    await vi.waitFor(() => expect(refreshes()).toBe(1));
    // the stream's frame for this rename: the title is the one shown, the sidebar is not read again
    act(() => FakeEventSource.instances[0]?.emit("changed", { what: "title" }));
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(refreshes()).toBe(1);
    title = "Generated title";
    act(() => FakeEventSource.instances[0]?.emit("changed", { what: "title" }));
    expect(await screen.findByRole("button", { name: /Generated title/ })).toBeTruthy();
    await vi.waitFor(() => expect(refreshes()).toBe(2));
  });

  it("a failed rename restores the title it replaced (the title shows at once, then rolls back)", async () => {
    let fail: () => void = () => {};
    const failed = new Promise<void>((r) => {
      fail = r;
    });
    api({
      [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi")] }),
      [`GET ${BASE}`]: () => json(200, CONV("c1", { title: "Kept" })),
      [`PATCH ${BASE}`]: async () => {
        await failed;
        return json(500, { error: { code: "internal", message: "x" } });
      },
    });
    await renderChat();
    await screen.findByText("hi");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /^Kept/ }));
    await user.click(await screen.findByRole("menuitem", { name: en.chat.rename }));
    const field = await screen.findByRole("textbox", { name: "Title" });
    await user.clear(field);
    await user.type(field, "Quarterly numbers{Enter}");
    // the row takes the new title before the kernel answers (the dialog stays open meanwhile, so
    // the title bar is behind it)
    const title = (name: RegExp) => screen.queryByRole("button", { name, hidden: true });
    await vi.waitFor(() => expect(title(/^Quarterly numbers/)).not.toBeNull());
    await act(async () => fail());
    // the kernel refused: the title it replaced is back, the error is told
    await vi.waitFor(() => expect(title(/^Kept/)).not.toBeNull());
    expect(title(/^Quarterly numbers/)).toBeNull();
    expect(await screen.findByText(en.errors.internal)).toBeTruthy();
  });

  it("while the run waits for a person the status bar's elapsed time stops at the wait (no running timer)", async () => {
    const at = (e: ReturnType<typeof ev>, s: number) => ({
      ...e,
      createdAt: new Date(Date.UTC(2026, 9, 26, 6, 0, 0) + s * 1000).toISOString(),
    });
    api({
      [`GET ${BASE}/events`]: () =>
        json(200, {
          events: [
            at(userMsg(1, "hi"), 0),
            at(runStarted(2), 1),
            at(
              ev(3, "question_asked", {
                step: 0,
                callId: "c2",
                questionId: "q1",
                form: { title: "t", fields: [] },
                expiresAt: "2026-10-27T00:00:00.000Z",
              }),
              8,
            ),
          ],
        }),
    });
    await renderChat("en");
    await screen.findByText("hi");
    // 7 s of work before the question; the days since then are waiting, not working
    expect(screen.getByText("Turn 1 · 7s elapsed")).toBeTruthy();
    expect(screen.getAllByText(en.chat.status.waiting).length).toBeGreaterThan(0);
    // a later render (the answer typed, a refetch) reads the same: the wait never ticks
    await act(() => new Promise((r) => setTimeout(r, 1100)));
    act(() => FakeEventSource.instances[0]?.emit("changed", { what: "queue" }));
    expect(screen.getByText("Turn 1 · 7s elapsed")).toBeTruthy();
  });

  it("a run starting, waiting and ending tells the sidebar (its state dot follows)", async () => {
    api({
      [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi")] }),
      [`GET ${BASE}`]: () => json(200, CONV("c1", { title: "Kept" })),
    });
    await renderChat();
    await screen.findByText("hi");
    await screen.findByRole("button", { name: /Kept/ });
    const refreshes = sidebarRefreshes();
    const es = FakeEventSource.instances[0] as FakeEventSource;
    act(() => es.emit("event", runStarted(2)));
    await vi.waitFor(() => expect(refreshes()).toBe(1));
    act(() =>
      es.emit(
        "event",
        ev(
          3,
          "question_asked",
          {
            step: 0,
            callId: "c2",
            questionId: "q1",
            form: { title: "t", fields: [] },
            expiresAt: "2026-10-19T00:00:00.000Z",
          },
          "r1",
        ),
      ),
    );
    await vi.waitFor(() => expect(refreshes()).toBe(2));
    act(() => es.emit("event", ev(4, "run_aborted", { byAccountId: "a1", reason: "user" }, "r1")));
    await vi.waitFor(() => expect(refreshes()).toBe(3));
    // an event that leaves the run phase as it was sends no further notice
    act(() => es.emit("event", userMsg(5, "again")));
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(refreshes()).toBe(3);
  });

  it.each(["archived", "deleted"])(
    "a conversation %s elsewhere tells the sidebar (changed on the stream)",
    async (what) => {
      api({
        [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi")] }),
        [`GET ${BASE}`]: () => json(200, CONV("c1", { title: "Kept" })),
      });
      await renderChat();
      await screen.findByText("hi");
      await screen.findByRole("button", { name: /Kept/ });
      const refreshes = sidebarRefreshes();
      act(() => FakeEventSource.instances[0]?.emit("changed", { what }));
      expect(refreshes()).toBe(1);
    },
  );

  it("the open conversation deleted elsewhere goes to / (a new conversation)", async () => {
    api({
      [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi")] }),
      [`GET ${BASE}`]: () => json(200, CONV("c1", { title: "Kept" })),
    });
    await renderChat();
    await screen.findByText("hi");
    act(() => FakeEventSource.instances[0]?.emit("changed", { what: "deleted" }));
    expect(router.push).toHaveBeenCalledWith("/");
  });

  it("overlapping reads of the conversation: the latest request wins, not the latest answer (m7)", async () => {
    let n = 0;
    let releaseSlow!: () => void;
    const slow = new Promise<void>((r) => {
      releaseSlow = r;
    });
    api({
      [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi")] }),
      [`GET ${BASE}`]: async () => {
        n += 1;
        // the second read answers last, with an older title
        if (n === 2) {
          await slow;
          return json(200, CONV("c1", { title: "Stale title" }));
        }
        return json(200, CONV("c1", { title: n === 1 ? null : "Fresh title" }));
      },
    });
    await renderChat();
    const refreshes = sidebarRefreshes();
    await screen.findByText("hi");
    await vi.waitFor(() => expect(n).toBe(1));
    act(() => FakeEventSource.instances[0]?.emit("changed", { what: "title" }));
    await vi.waitFor(() => expect(n).toBe(2));
    act(() => FakeEventSource.instances[0]?.emit("changed", { what: "title" }));
    expect(await screen.findByRole("button", { name: /Fresh title/ })).toBeTruthy();
    await act(async () => {
      releaseSlow();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(screen.queryByRole("button", { name: /Stale title/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Fresh title/ })).toBeTruthy();
    // the sidebar heard of each new title
    expect(refreshes()).toBe(2);
  });

  it("Retry on the failed run row re-sends the last message with retryOf", async () => {
    const calls = api({
      [`GET ${BASE}/events`]: () =>
        json(200, {
          events: [
            userMsg(1, "hello"),
            runStarted(2),
            ev(3, "run_failed", { error: { code: "model.timeout", message: "x" } }),
          ],
        }),
      [`POST ${BASE}/messages`]: () => json(202, { event: userMsg(4, "hello", { retryOf: 1 }) }),
    });
    await renderChat();
    const retry = await screen.findByRole("button", { name: "Retry" });
    await userEvent.setup().click(retry);
    expect(bodyOf(posts(calls, `${BASE}/messages`)[0])).toMatchObject({
      text: "hello",
      retryOf: 1,
    });
    // The retry folds into the run row instead of a second bubble.
    await vi.waitFor(() => expect(screen.getAllByText("hello")).toHaveLength(1));
    expect(document.querySelector('[data-run-status="failed"]')?.textContent).toContain(
      en.chat.run.failedRetried,
    );
  });

  it("a run blocked by a policy hook names the extension; a pinned-skill failure says so", async () => {
    api({
      [`GET ${BASE}/events`]: () =>
        json(200, {
          events: [
            userMsg(1, "hi"),
            runStarted(2),
            ev(3, "hook_denied", {
              mount: "model.request",
              plugin: "guard",
              reason: "no",
              cause: "deny",
              step: 0,
            }),
            ev(4, "run_failed", { error: { code: "run.hook_denied", message: "x" } }),
            userMsg(5, "again"),
            runStarted(6, "r2"),
            ev(
              7,
              "run_failed",
              {
                error: {
                  code: "storage.unavailable",
                  message: 'Pinned skill "notes" cannot be read',
                },
              },
              "r2",
            ),
          ],
        }),
    });
    await renderChat();
    await screen.findByText("again");
    const [hook, pinned] = [
      ...document.querySelectorAll<HTMLElement>('[data-run-status="failed"]'),
    ];
    expect(hook?.textContent).toContain(en.errors.run.hook_denied.replace("{plugin}", "guard"));
    // a denial is not retried (the policy would deny it again)
    expect(within(hook as HTMLElement).queryByRole("button", { name: "Retry" })).toBeNull();
    expect(pinned?.textContent).toContain(en.errors.run.pinned_unavailable);
    // the kernel's text (it names the skill) stays behind the raw-error toggle
    expect(pinned?.textContent).not.toContain('Pinned skill "notes" cannot be read');
    await userEvent
      .setup()
      .click(within(pinned as HTMLElement).getByRole("button", { name: "Raw error" }));
    expect(pinned?.textContent).toContain('Pinned skill "notes" cannot be read');
  });

  it("thinking shows by the model's capabilities.reasoning", async () => {
    api({
      [`GET ${BASE}/events`]: () =>
        json(200, {
          events: [
            userMsg(1, "hi"),
            runStarted(2),
            ev(3, "assistant_message", {
              step: 0,
              content: [
                { type: "thinking", text: "deep thought" },
                { type: "text", text: "answer" },
              ],
              stopReason: "end_turn",
            }),
          ],
        }),
      "GET /api/v1/orgs/o1/models": () =>
        json(200, {
          providers: [
            {
              provider: "model-fake",
              models: [
                {
                  id: "fake-1",
                  displayName: "Fake 1",
                  capabilities: { reasoning: false },
                  parameters: [],
                },
              ],
            },
          ],
        }),
    });
    await renderChat();
    await screen.findByText("answer");
    await vi.waitFor(() => expect(screen.queryByText(/^Thought for/)).toBeNull());
  });
});

describe("the conversation page's server gate", () => {
  it("a conversation the kernel does not show is the not-found state in the shell; without an org nothing renders", async () => {
    const calls = stubApi({});
    // a missing object is no unknown route: the page renders its not-found state (HTTP 200)
    await renderChatRoute({
      routes: {
        [`GET ${BASE}`]: () =>
          json(404, { error: { code: "conversation.not_found", message: "x" } }),
        [`GET ${BASE}/events`]: () =>
          json(404, { error: { code: "conversation.not_found", message: "x" } }),
      },
    });
    expect(screen.getAllByRole("heading", { name: en.notFound.title }).length).toBeGreaterThan(0);
    expect(document.querySelector('[data-template="ConversationPage"]')).toBeNull();
    expect(calls).toEqual([]);
    cleanup();
    const none = await renderChatRoute({ routes: {}, me: { ...ME, currentOrgId: null } });
    expect(none.calls.map((c) => c.url)).toEqual(["/api/v1/me"]);
    expect(document.querySelector('[data-template="ConversationPage"]')).toBeNull();
  });
});

describe("server-decided failures (ruling R5)", () => {
  const failed = () => json(500, { error: { code: "internal", message: "x" } });

  it("a secondary read the kernel fails draws its section's error state; the browser reads nothing", async () => {
    const calls = api({
      [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi")] }),
      [`GET ${BASE}/sandbox`]: failed,
      [`GET ${BASE}/files`]: failed,
      [`GET ${BASE}/queue`]: failed,
      "GET /api/v1/orgs/o1/ui/contributions": failed,
      "GET /api/v1/orgs/o1/connectors": () =>
        json(403, { error: { code: "forbidden", message: "x" } }),
    });
    window.history.replaceState(null, "", "/chat/c1#properties");
    await renderChat();
    const props = await screen.findByRole("complementary", { name: "Properties" });
    expect(within(props).getByText(new RegExp(en.chatPanel.sandboxFailed))).toBeTruthy();
    expect(screen.getByText("hi")).toBeTruthy();
    expect(calls).toEqual([]);
    window.history.replaceState(null, "", "/");
  });

  it("anything that is not a kernel refusal or failure propagates (a fetch bug)", async () => {
    stubApi({});
    await expect(
      renderChatRoute({
        routes: {
          [`GET ${BASE}`]: () => json(200, CONV()),
          [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi")] }),
          [`GET ${BASE}/files`]: () => {
            throw new TypeError("boom");
          },
        },
      }),
    ).rejects.toThrow(TypeError);
  });
});

describe("the first open after the server's snapshot (web query cache spec §6)", () => {
  it("an open of a named conversation that delivers no event reads nothing outside the log", async () => {
    const calls = api({
      [`GET ${BASE}`]: () => json(200, CONV("c1", { title: "Kept" })),
      [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi")] }),
    });
    await renderChat();
    expect(calls).toEqual([]);
    act(() => FakeEventSource.instances[0]?.emit("open"));
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(calls).toEqual([]);
  });

  it("a catch-up that delivers events reads the pieces outside the log again", async () => {
    const calls = api({
      [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi")] }),
    });
    await renderChat();
    const es = FakeEventSource.instances[0] as FakeEventSource;
    act(() => {
      es.emit("open");
      es.emit("event", userMsg(2, "while away"));
    });
    await vi.waitFor(() =>
      expect(new Set(calls.map((c) => c.url.split("?")[0]))).toEqual(
        new Set([BASE, `${BASE}/queue`, `${BASE}/files`]),
      ),
    );
    expect(await screen.findByText("while away")).toBeTruthy();
  });
});

describe("switching conversations", () => {
  it("never shows the previous conversation's queue or draft under the new id", async () => {
    stubApi({
      [`GET ${BASE}`]: () => json(200, CONV("c1")),
      "GET /api/v1/orgs/o1/conversations/c2": () => json(200, CONV("c2")),
      "GET /api/v1/orgs/o1/agents": () => json(200, AGENTS),
      "GET /api/v1/orgs/o1/models": () => json(200, MODELS),
      [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "in one")] }),
      "GET /api/v1/orgs/o1/conversations/c2/events": () =>
        json(200, {
          events: [
            ev(
              1,
              "user_message",
              { content: [{ type: "text", text: "in two" }], authorAccountId: "a1" },
              null,
              "c2",
            ),
          ],
        }),
      [`GET ${BASE}/queue`]: () =>
        json(200, {
          items: [
            {
              id: "q1",
              text: "queued in one",
              files: [],
              attachments: [],
              clientMessageId: "x",
              createdAt: "2026-10-26T06:00:00.000Z",
              position: 1,
            },
          ],
          paused: false,
        }),
      "GET /api/v1/orgs/o1/conversations/c2/queue": () => json(200, { items: [], paused: false }),
    });
    const r = await renderChat();
    expect(await screen.findByText("queued in one")).toBeTruthy();
    await userEvent.setup().type(input(), "draft for one");
    // the client navigation to c2: the same view gets new props and reads c2 from the browser
    const element = await ChatPage({ params: Promise.resolve({ conversationId: "c2" }) });
    r.rerender(pageElement(element, { locale: "en" }));
    expect(await screen.findByText("in two")).toBeTruthy();
    expect(screen.queryByText("queued in one")).toBeNull();
    expect(screen.queryByText("in one")).toBeNull();
    expect(input()).toHaveProperty("value", "");
  });
});

/** The reads of `/` (the new conversation) on the server. */
const NEW_CHAT = {
  "GET /api/v1/orgs/o1/attachments/limits": () => json(200, LIMITS),
  "GET /api/v1/orgs/o1/agents": () => json(200, AGENTS),
  "GET /api/v1/orgs/o1/models": () => json(200, MODELS),
  "GET /api/v1/orgs/o1/conversations/groups": () => json(200, { groups: [], next: null }),
};

/** A chip of the new conversation's agents row. */
const agentChip = (name: string) =>
  within(screen.getByRole("group", { name: "Choose an agent" })).getByRole("button", { name });

describe("a new conversation (/)", () => {
  it("?agent= picks the agent; the first send creates the conversation and replaces the URL", async () => {
    resetNavigation("/");
    const calls = stubApi({
      "POST /api/v1/orgs/o1/conversations": () =>
        json(201, { ...CONV("c9", { agentId: "ag2" }), event: userMsg(1, "start") }),
    });
    const { calls: server } = await renderRouteWithCache("/?agent=ag2", NEW_CHAT);
    // the first paint is the server's: agents, the most recent agent and the models
    expect(agentChip("Second agent").getAttribute("aria-pressed")).toBe("true");
    expect(server.map((c) => c.url)).toEqual(
      expect.arrayContaining([
        "/api/v1/orgs/o1/agents",
        "/api/v1/orgs/o1/models",
        "/api/v1/orgs/o1/conversations/groups",
        "/api/v1/orgs/o1/attachments/limits",
      ]),
    );
    // Nothing is fetched in the browser, and nothing is created before the first send.
    expect(calls).toEqual([]);
    await userEvent.setup().type(input(), "start{Enter}");
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith("/chat/c9"));
    expect(bodyOf(calls.find((c) => c.method === "POST"))).toMatchObject({
      agentId: "ag2",
      message: { text: "start" },
    });
  });

  it("the new conversation's status bar reads <login>@<slug>:~ with the time zone", async () => {
    resetNavigation("/");
    expectNoFirstPaintFetch();
    const { container } = await renderRouteWithCache("/", NEW_CHAT, {
      session: { timeZone: "UTC+8" },
    });
    const bar = container.querySelector('[data-part="status-bar"]') as HTMLElement;
    expect((bar.querySelector('[data-part="status-bar-context"]') as HTMLElement).textContent).toBe(
      "grant@acme:~",
    );
    expect(bar.textContent).toContain("UTC+8");
  });

  it("without ?agent= the agent most recently talked to is picked, and the agents row changes it", async () => {
    resetNavigation("/");
    expectNoFirstPaintFetch();
    await renderRouteWithCache("/", {
      ...NEW_CHAT,
      "GET /api/v1/orgs/o1/conversations/groups": () =>
        json(200, {
          groups: [
            {
              agent: { id: "ag2", name: "Second agent" },
              latestAt: "x",
              conversations: [],
              more: false,
            },
          ],
          next: null,
        }),
    });
    expect(agentChip("Second agent").getAttribute("aria-pressed")).toBe("true");
    // the agents row changes it (the composer has no agent picker here)
    expect(screen.queryByRole("button", { name: /: Second agent$/ })).toBeNull();
    await userEvent.setup().click(agentChip("Echo agent"));
    expect(agentChip("Echo agent").getAttribute("aria-pressed")).toBe("true");
    expect(input().getAttribute("placeholder")).toBe("What should Echo agent do?");
  });
});

describe("the first message from / (conversation send spec §2.1)", () => {
  const C9 = "/api/v1/orgs/o1/conversations/c9";

  async function startNew() {
    resetNavigation("/");
    let answer: (r: Response) => void = () => {};
    let cmid = "";
    const calls = stubApi({
      "POST /api/v1/orgs/o1/conversations": (c) => {
        cmid = (bodyOf(c) as { message: { clientMessageId: string } }).message.clientMessageId;
        return new Promise<Response>((r) => {
          answer = r;
        });
      },
      // the sidebar's groups read again after the create, and never answer here
      "GET /api/v1/orgs/o1/conversations/groups": () => new Promise<Response>(() => {}),
    });
    const { client } = await renderRouteWithCache("/", NEW_CHAT);
    return { calls, client, answer: (r: Response) => answer(r), cmid: () => cmid };
  }

  it("switches to the conversation layout with the pending bubble at once", async () => {
    const d = await startNew();
    fireEvent.change(input(), { target: { value: "start" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(input()).toHaveProperty("value", "");
    expect(document.querySelector('[data-part="new-conversation-body"]')).toBeNull();
    const bubble = screen.getByText("start", { selector: '[data-part="bubble-body"]' });
    expect(bubble.closest("[data-pending]")).not.toBeNull();
    await vi.waitFor(() => expect(d.calls.some((c) => c.method === "POST")).toBe(true));
  });

  it("seeds the cache from the answer and navigates without waiting for the groups", async () => {
    const d = await startNew();
    await userEvent.setup().type(input(), "start{Enter}");
    await vi.waitFor(() => expect(d.calls.some((c) => c.method === "POST")).toBe(true));
    const event = userMsg(1, "start", { clientMessageId: d.cmid() });
    const conversation = CONV("c9").conversation;
    await act(async () => d.answer(json(201, { conversation, event })));
    // the groups' read never answers: the navigation does not wait for it
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith("/chat/c9"));
    const c = keys.org("o1").conversation("c9");
    expect(d.client.getQueryData(c.row())).toEqual(conversation);
    expect(d.client.getQueryData(c.events())).toEqual([event]);
    expect(d.client.getQueryData(c.queue())).toEqual({ items: [], paused: false });
    expect(d.client.getQueryData(c.files())).toEqual([]);
    expect(d.client.getQueryData(c.sandbox())).toBeNull();

    // /chat/c9 paints from the seeded cache: no read of the row, events, queue or files, and
    // the stream opens after the event's seq
    cleanup();
    FakeEventSource.instances = [];
    resetNavigation("/chat/c9");
    params.conversationId = "c9";
    const { calls } = await renderRouteEmptyCache("/chat/c9", snapshotDefaults("c9"), {
      client: d.client,
    });
    expect(screen.getByText("start", { selector: '[data-part="bubble-body"]' })).toBeTruthy();
    expect(FakeEventSource.instances.map((e) => e.url)).toEqual([`${C9}/stream?after=1`]);
    // the first message was sent from this tab: the working line carries over the navigation
    expect(document.querySelector('[data-part="working-line"]')).not.toBeNull();
    await new Promise((r) => setTimeout(r, 20));
    const reads = calls.filter((x) => x.method === "GET").map((x) => x.url.split("?")[0]);
    for (const path of [C9, `${C9}/events`, `${C9}/queue`, `${C9}/files`, `${C9}/sandbox`])
      expect(reads).not.toContain(path);
  });

  it("a create that switched the model answers both events: /chat/<id> reads no events and streams after the last (no skeleton)", async () => {
    const d = await startNew();
    await userEvent.setup().type(input(), "start{Enter}");
    await vi.waitFor(() => expect(d.calls.some((c) => c.method === "POST")).toBe(true));
    const switched = ev(
      1,
      "model_switched",
      {
        model: { provider: "model-fake", model: "fake-2" },
        effort: null,
        byAccountId: "a1",
        reason: "user",
      },
      null,
      "c9",
    );
    const event = { ...userMsg(2, "start", { clientMessageId: d.cmid() }), conversationId: "c9" };
    const conversation = CONV("c9").conversation;
    await act(async () => d.answer(json(201, { conversation, event, events: [switched, event] })));
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith("/chat/c9"));
    const c = keys.org("o1").conversation("c9");
    expect(d.client.getQueryData(c.events())).toEqual([switched, event]);

    cleanup();
    FakeEventSource.instances = [];
    resetNavigation("/chat/c9");
    params.conversationId = "c9";
    const { container, calls } = await renderRouteEmptyCache("/chat/c9", snapshotDefaults("c9"), {
      client: d.client,
    });
    // painted from the seed: the bubble, never the thread's loading state
    expect(screen.getByText("start", { selector: '[data-part="bubble-body"]' })).toBeTruthy();
    expect(container.querySelector('[data-part="loading-turn"]')).toBeNull();
    expect(FakeEventSource.instances.map((e) => e.url)).toEqual([`${C9}/stream?after=2`]);
    await new Promise((r) => setTimeout(r, 20));
    const reads = calls.filter((x) => x.method === "GET").map((x) => x.url.split("?")[0]);
    expect(reads).not.toContain(`${C9}/events`);
  });

  it("a second ↵ before the conversation exists keeps the text and says why, until it exists", async () => {
    const d = await startNew();
    const user = userEvent.setup();
    await user.type(input(), "start{Enter}");
    expect(screen.queryByText(en.chat.sendAfterCreate)).toBeNull();
    await user.type(input(), "again{Enter}");
    expect(input()).toHaveProperty("value", "again");
    expect(screen.getByText(en.chat.sendAfterCreate)).toBeTruthy();
    expect(zh.chat.sendAfterCreate).toBe("会话创建后即可继续发送");
    expect(en.chat.sendAfterCreate).toBe("You can send again once the conversation is created");
    expect(d.calls.filter((c) => c.method === "POST")).toHaveLength(1);
    const event = userMsg(1, "start", { clientMessageId: d.cmid() });
    await act(async () => d.answer(json(201, { conversation: CONV("c9").conversation, event })));
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith("/chat/c9"));
    expect(screen.queryByText(en.chat.sendAfterCreate)).toBeNull();
  });

  it("a failed create goes back to the new conversation with the text in the composer", async () => {
    const d = await startNew();
    await userEvent.setup().type(input(), "start{Enter}");
    await vi.waitFor(() => expect(d.calls.some((c) => c.method === "POST")).toBe(true));
    await act(async () => d.answer(json(500, { error: { code: "internal", message: "boom" } })));
    await vi.waitFor(() => expect(input()).toHaveProperty("value", "start"));
    expect(screen.queryByText("start", { selector: '[data-part="bubble-body"]' })).toBeNull();
    expect(router.replace).not.toHaveBeenCalled();
  });
});

describe("the new conversation once the org can run", () => {
  it("with a model and an agent the composer shows as before", async () => {
    resetNavigation("/");
    expectNoFirstPaintFetch();
    const { container } = await renderRouteWithCache("/", NEW_CHAT);
    expect(agentChip("Echo agent")).toBeTruthy();
    expect(input()).toBeTruthy();
    expect(container.querySelector('[data-template="OnboardingPage"]')).toBeNull();
  });

  it("while the org is in setup, the page renders nothing (the frame draws the setup home)", async () => {
    resetNavigation("/");
    expectNoFirstPaintFetch();
    const { container, calls } = await renderRouteWithCache("/", NEW_CHAT, {
      readiness: { modelProvider: "none", agents: 0 },
    });
    expect(container.querySelector('[data-template="ConversationPage"]')).toBeNull();
    expect(calls.some((c) => c.url.endsWith("/agents"))).toBe(false);
  });
});

describe("the conversation page in the app frame", () => {
  const twoOrgs = (currentOrgId: string) => ({
    ...ME,
    currentOrgId,
    memberships: [...ME.memberships, { orgId: "o2", slug: "b", name: "Beta", role: "member" }],
  });

  it("switching org opens the new org's home with a full navigation and never reads the conversation with the new org", async () => {
    const calls = api({
      "PUT /api/v1/me/current-org": () => new Response(null, { status: 204 }),
      [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi")] }),
    });
    const { element } = await onServer(
      () => ChatPage({ params: Promise.resolve({ conversationId: "c1" }) }),
      { ...snapshotDefaults("c1"), ...lastStubRoutes() },
      { me: twoOrgs("o1") },
    );
    renderFrame(shellOf(twoOrgs("o1")), element, {
      locale: "en",
      version: "v0",
    });
    await screen.findByText("hi");
    // The page draws its own status bar with the version.
    expect(screen.getAllByText("v0").length).toBeGreaterThan(0);
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: /^Current organization: .*, switch organization$/ }),
    );
    // jsdom has no layout: pick the item with the keyboard (see design menu-submenu tests)
    (await screen.findByRole("menuitemradio", { name: "Beta" })).focus();
    await user.keyboard("{Enter}");
    await vi.waitFor(() => expect(navigateBrowser).toHaveBeenCalledWith("/"));
    expect(router.push).not.toHaveBeenCalled();
    // the old org's conversation stays until the new document replaces it
    expect(screen.getByText("hi")).toBeTruthy();
    expect(calls.some((c) => c.url.includes("/orgs/o2/"))).toBe(false);
  });
});

describe("composer: / prompts and @ resources", () => {
  const APPS = "/api/v1/orgs/o1/connectors";
  const PROMPTS = {
    prompts: [
      {
        connectorId: "a1",
        connectorSlug: "docs",
        connectorName: "Docs",
        name: "summarize",
        description: "Summarize a topic",
        arguments: [{ name: "topic", description: "What to summarize", required: true }],
      },
    ],
    unavailable: [{ connectorId: "a2", connectorName: "Mail", reason: "not_connected" }],
  };
  const RESOURCES = {
    resources: [
      {
        connectorId: "a1",
        connectorSlug: "docs",
        connectorName: "Docs",
        uri: "docs://handbook",
        name: "Handbook",
      },
    ],
    unavailable: [],
  };

  it("/ lists the prompts; arguments in a dialog; the rendered text goes into the input", async () => {
    const calls = api({
      [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi")] }),
      [`GET ${APPS}/prompts`]: () => json(200, PROMPTS),
      [`POST ${APPS}/a1/prompts/summarize`]: () => json(200, { text: "Summarize cats please" }),
      "GET /api/v1/orgs/o1/agents/ag1/invocable-skills": () => json(200, { skills: [] }),
    });
    await renderChat();
    await screen.findByText("hi");
    const user = userEvent.setup();
    await user.type(input(), "/");
    expect(input()).toHaveProperty("value", "");
    // the label, then the description (phase D palette items)
    const option = await screen.findByRole("option", {
      name: "/docs:summarizeSummarize a topic",
    });
    expect(
      screen.getByRole("option", { name: `Mail · ${en.chat.connectorUnavailable.not_connected}` }),
    ).toBeTruthy();
    await user.click(option);
    const dialog = await screen.findByRole("dialog", { name: "/docs:summarize" });
    await user.type(within(dialog).getByLabelText(/topic/), "cats");
    await user.click(within(dialog).getByRole("button", { name: en.chat.insertPrompt }));
    await vi.waitFor(() => expect(input()).toHaveProperty("value", "Summarize cats please"));
    expect(bodyOf(calls.find((c) => c.url === `${APPS}/a1/prompts/summarize`))).toEqual({
      arguments: { topic: "cats" },
    });
  });

  it("@ attaches a resource sent with the message; the bubble shows it, not its body", async () => {
    const calls = api({
      [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi")] }),
      [`GET ${APPS}/resources`]: () => json(200, RESOURCES),
      [`POST ${BASE}/messages`]: (c) =>
        json(202, {
          event: ev(
            2,
            "user_message",
            {
              content: [
                { type: "text", text: (bodyOf(c) as { text: string }).text },
                { type: "text", text: "Attached resource …" },
              ],
              attachments: [
                { appId: "a1", appName: "Docs", uri: "docs://handbook", name: "Handbook" },
              ],
              authorAccountId: "a1",
            },
            null,
          ),
        }),
    });
    await renderChat();
    await screen.findByText("hi");
    const user = userEvent.setup();
    await user.type(input(), "read @");
    expect(input()).toHaveProperty("value", "read ");
    await user.click(await screen.findByRole("option", { name: "Handbook · docs://handbook" }));
    expect(screen.getByText("@Handbook")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: en.chat.send }));
    expect(bodyOf(posts(calls, `${BASE}/messages`)[0])).toMatchObject({
      text: "read",
      attachments: [{ connectorId: "a1", uri: "docs://handbook" }],
    });
    expect(await screen.findByText("@Handbook · Docs")).toBeTruthy();
    expect(screen.queryByText("Attached resource …")).toBeNull();
  });
});

describe("tool rows read the tool info API", () => {
  it("titles and sources come from GET …/tools?keys=", async () => {
    const calls = api({
      [`GET ${BASE}/events`]: () =>
        json(200, {
          events: [
            userMsg(1, "go"),
            ev(2, "assistant_message", {
              step: 0,
              content: [
                {
                  type: "tool_call",
                  id: "c1",
                  name: "plugin__slack__search",
                  input: { query: "#feedback" },
                },
              ],
              stopReason: "tool_use",
            }),
          ],
        }),
      [`GET ${BASE}/tools`]: () =>
        json(200, {
          tools: [
            {
              key: "plugin__slack__search",
              title: "Search messages",
              kind: "connector",
              sandbox: false,
              keyArgs: ["query"],
              tool: "search",
              source: { kind: "connector", id: "k1", name: "Slack" },
            },
          ],
        }),
    });
    const { calls: server } = await renderChat("en");
    // read with the snapshot on the server: the first paint already has the tool info.
    // Claude Code's look: the connector's name and the local tool, the title as the tooltip
    const name = screen.getByText("Slack [search]");
    expect(name.closest('[data-part="tool-label"]')?.getAttribute("title")).toBe("Search messages");
    expect(screen.queryByText(/Slack: Search messages/)).toBeNull();
    expect(server.some((c) => c.url.endsWith("/tools?keys=plugin__slack__search"))).toBe(true);
    expect(calls.some((c) => c.url.includes("/tools?"))).toBe(false);
  });
});

describe("run rows (spec §6.16.23)", () => {
  const usage = (seq: number, input: number, output: number) =>
    ev(seq, "usage", {
      step: 0,
      provider: "model-fake",
      model: "fake-1",
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  const authFailure = [
    userMsg(1, "hello"),
    runStarted(2),
    ev(3, "run_failed", { error: { code: "model.auth", message: "401 Unauthorized: bad key" } }),
  ];
  const as = (role: string, opts: { id?: string; superAdmin?: boolean } = {}) => ({
    ...ME,
    account: { ...ME.account, id: opts.id ?? "a9", isSuperAdmin: opts.superAdmin ?? false },
    memberships: [{ ...(ME.memberships[0] as (typeof ME.memberships)[number]), role }],
  });
  const row = () => document.querySelector<HTMLElement>("[data-entry='run']") as HTMLElement;

  it("a finished run ends with one quiet collapsed row; the properties panel shows the last run", async () => {
    api({
      [`GET ${BASE}/events`]: () =>
        json(200, {
          events: [
            userMsg(1, "hi"),
            runStarted(2),
            usage(3, 1000, 234),
            ev(4, "run_finished", { reason: "end_turn", consumedUpToSeq: 1 }),
          ],
        }),
    });
    window.history.replaceState(null, "", "/chat/c1#properties");
    await renderChat();
    const line = within(row()).getByRole("button", {
      name: /^Run · fake-1 · 2\.0s · 1,234 tokens/,
    });
    expect(line.getAttribute("aria-expanded")).toBe("false");
    expect(row().getAttribute("data-run-status")).toBe("ok");
    expect(row().querySelector('[data-part="run-status"]')?.textContent).toBe("Done");
    expect(document.querySelectorAll("[data-entry='run']")).toHaveLength(1);
    const props = await screen.findByRole("complementary", { name: "Properties" });
    expect(props.querySelector('[data-part="context-last-run"]')?.textContent).toBe(
      "Last run · fake-1 · 2.0s · 1,234 tokens",
    );
    window.history.replaceState(null, "", "/");
  });

  it("a failed run is open: the localized error, the raw text behind its toggle, Retry and the links (an owner who is a super admin)", async () => {
    api({ [`GET ${BASE}/events`]: () => json(200, { events: authFailure }) });
    await renderChat();
    const region = within(row()).getByRole("region", { name: "Run details" });
    expect(region.textContent).toContain(en.errors.model.auth);
    expect(region.textContent).not.toContain("401 Unauthorized");
    expect(within(region).getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(
      within(region).getByRole("link", { name: en.chat.run.trajectory }).getAttribute("href"),
    ).toBe("/trajectories/c1");
    expect(
      within(region).getByRole("link", { name: en.chat.run.configureModels }).getAttribute("href"),
    ).toBe("/admin/extensions");
    // no duplicate: the failure is the row, never a divider too
    expect(document.querySelector("[data-entry='divider']")).toBeNull();
  });

  it.each([
    [
      "a member who owns the agent: the trajectory, no fix entry",
      as("member", { id: "a1" }),
      true,
      false,
    ],
    ["a member who does not own it: no links", as("member"), false, false],
    ["a guest: no links", as("guest", { id: "a1" }), false, false],
    ["an org admin: the trajectory", as("admin"), true, false],
    [
      "a super admin who is a plain member: the fix entry only",
      as("member", { superAdmin: true }),
      false,
      true,
    ],
  ])("%s", async (_name, me, trajectory, fix) => {
    api({ [`GET ${BASE}/events`]: () => json(200, { events: authFailure }) });
    await renderChatRoute({ locale: "en", me });
    const region = within(row()).getByRole("region", { name: "Run details" });
    expect(within(region).queryByRole("link", { name: en.chat.run.trajectory }) !== null).toBe(
      trajectory,
    );
    expect(within(region).queryByRole("link", { name: en.chat.run.configureModels }) !== null).toBe(
      fix,
    );
  });

  it("a sub-agent conversation links no trajectory (the kernel checks the parent's agent)", async () => {
    api({
      [`GET ${BASE}`]: () =>
        json(200, CONV("c1", { parentConversationId: "p1", subagentType: "general" })),
      [`GET ${BASE}/events`]: () => json(200, { events: authFailure }),
    });
    await renderChat();
    const region = within(row()).getByRole("region", { name: "Run details" });
    expect(within(region).queryByRole("link", { name: en.chat.run.trajectory })).toBeNull();
    // the deployment fix entry does not depend on the agent
    expect(within(region).getByRole("link", { name: en.chat.run.configureModels })).toBeTruthy();
  });

  it("the fix entry only for a model setup failure", async () => {
    api({
      [`GET ${BASE}/events`]: () =>
        json(200, {
          events: [
            userMsg(1, "hello"),
            runStarted(2),
            ev(3, "run_failed", { error: { code: "model.timeout", message: "timeout" } }),
          ],
        }),
    });
    await renderChat();
    expect(within(row()).queryByRole("link", { name: en.chat.run.configureModels })).toBeNull();
    expect(within(row()).getByRole("link", { name: en.chat.run.trajectory })).toBeTruthy();
  });
});
