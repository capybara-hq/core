import { DesignProvider, type LinkComponent, ToastProvider } from "@capybara-hq/design";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import ChatPage from "../src/app/[locale]/(app)/chat/[conversationId]/page";
import NewChatPage from "../src/app/[locale]/(app)/chat/page";
import { AppFrame } from "../src/components/shell/AppFrame";
import { bodyOf, type Call, json, stubApi } from "./support/api";
import {
  AGENTS,
  CONV,
  ev,
  FakeEventSource,
  MODELS,
  runStarted,
  userMsg,
} from "./support/conversation";
import { Link, resetNavigation, router } from "./support/navigation";
import { ME, renderPage } from "./support/render";

const params = { conversationId: "c1" };
const search = new URLSearchParams();
vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("next/navigation", () => ({
  useParams: () => params,
  useSearchParams: () => search,
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
    ...extra,
  });
}

const renderChat = (locale: "zh" | "en" = "en") => renderPage(<ChatPage />, { locale });
const input = (m = en) => screen.getByRole("textbox", { name: m.chat.inputLabel, hidden: true });
const posts = (calls: Call[], path: string) =>
  calls.filter((c) => c.method === "POST" && c.url.split("?")[0] === path);

beforeEach(() => {
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
    const { container } = (() => {
      api({
        [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi"), runStarted(2)] }),
      });
      return renderChat("zh");
    })();
    expect(container.querySelector('[data-template="ConversationPage"]')).not.toBeNull();
    expect(await screen.findByText("hi")).toBeTruthy();
    expect(await screen.findByText(/^未命名会话 · /)).toBeTruthy();
    expect(screen.getByText(zh.chat.status.running)).toBeTruthy();
    expect(screen.getByText(/第 1 轮 · 已用/)).toBeTruthy();
    expect(screen.getByText("hi").closest("[data-entry]")?.getAttribute("data-entry")).toBe("user");
  });

  it.each(["zh", "en"] as const)(
    "while running, Stop calls abort; the input stays enabled; a stop divider follows (%s)",
    async (locale) => {
      const m = locale === "zh" ? zh : en;
      const calls = api({
        [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi"), runStarted(2)] }),
        [`POST ${BASE}/abort`]: () => json(202, { runId: "r1" }),
      });
      renderChat(locale);
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
      expect(document.querySelector('[data-divider="stopped"]')?.textContent).toContain(m.chat.you);
    },
  );

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
    renderChat();
    await vi.waitFor(() =>
      expect(document.querySelectorAll('[data-divider="stopped"]')).toHaveLength(2),
    );
    const dividers = () =>
      [...document.querySelectorAll('[data-divider="stopped"]')].map((d) => d.textContent ?? "");
    await vi.waitFor(() => expect(dividers()[0]).toContain("Bo Admin"));
    expect(dividers()[1]).toContain(en.chat.anotherMember);
    expect(dividers().join(" ")).not.toContain("acc-");
  });

  it("streams deltas with a cursor; the assistant_message replaces the draft", async () => {
    api({ [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi"), runStarted(2)] }) });
    renderChat();
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

  it("↵ while running interjects (POST messages); ⌘↵ and Ctrl+↵ queue (POST queue)", async () => {
    let n = 2;
    const calls = api({
      [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi"), runStarted(2)] }),
      [`POST ${BASE}/messages`]: (c) =>
        json(202, { event: userMsg(++n, String((bodyOf(c) as { text: string }).text)) }),
      [`POST ${BASE}/queue`]: (c) =>
        json(201, {
          item: {
            id: `q${n}`,
            text: (bodyOf(c) as { text: string }).text,
            files: [],
            attachments: [],
            clientMessageId: "x",
            createdAt: "2026-10-26T06:00:00.000Z",
            position: 1,
          },
        }),
    });
    renderChat();
    await screen.findByRole("button", { name: en.chat.stop });
    expect(input().getAttribute("placeholder")).toMatch(/↵ to send now/);
    const user = userEvent.setup();
    await user.type(input(), "now{Enter}");
    await vi.waitFor(() => expect(posts(calls, `${BASE}/messages`)).toHaveLength(1));
    expect(bodyOf(posts(calls, `${BASE}/messages`)[0])).toMatchObject({ text: "now" });
    expect(
      typeof (bodyOf(posts(calls, `${BASE}/messages`)[0]) as { clientMessageId: unknown })
        .clientMessageId,
    ).toBe("string");
    await user.type(input(), "later{Meta>}{Enter}{/Meta}");
    await vi.waitFor(() => expect(posts(calls, `${BASE}/queue`)).toHaveLength(1));
    await user.type(input(), "later2{Control>}{Enter}{/Control}");
    await vi.waitFor(() => expect(posts(calls, `${BASE}/queue`)).toHaveLength(2));
    expect(posts(calls, `${BASE}/queue`).map((c) => (bodyOf(c) as { text: string }).text)).toEqual([
      "later",
      "later2",
    ]);
    expect(posts(calls, `${BASE}/messages`)).toHaveLength(1);
  });

  it("⌘↵ queues with the pending model / effort pick and clears it (final review I1)", async () => {
    let n = 2;
    const calls = api({
      [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi"), runStarted(2)] }),
      [`POST ${BASE}/messages`]: (c) =>
        json(202, { event: userMsg(++n, String((bodyOf(c) as { text: string }).text)) }),
      [`POST ${BASE}/queue`]: (c) =>
        json(201, {
          item: {
            id: `q${++n}`,
            text: (bodyOf(c) as { text: string }).text,
            files: [],
            attachments: [],
            clientMessageId: "x",
            model: null,
            effort: null,
            createdAt: "2026-10-26T06:00:00.000Z",
            position: 1,
          },
        }),
    });
    renderChat();
    await screen.findByRole("button", { name: en.chat.stop });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: `${en.chat.pickModel}: Fake 1` }));
    await user.click(await screen.findByRole("menuitemradio", { name: /Fake 2/ }));
    await user.click(await screen.findByRole("button", { name: `${en.chat.pickEffort}: Low` }));
    await user.click(await screen.findByRole("menuitemradio", { name: /High/ }));
    await user.type(input(), "later{Meta>}{Enter}{/Meta}");
    await vi.waitFor(() => expect(posts(calls, `${BASE}/queue`)).toHaveLength(1));
    expect(bodyOf(posts(calls, `${BASE}/queue`)[0])).toMatchObject({
      text: "later",
      model: { provider: "model-fake", model: "fake-2" },
      effort: "high",
    });
    // the pick went with the queued message: the next send carries none
    await user.type(input(), "now{Enter}");
    await vi.waitFor(() => expect(posts(calls, `${BASE}/messages`)).toHaveLength(1));
    const body = bodyOf(posts(calls, `${BASE}/messages`)[0]) as Record<string, unknown>;
    expect(body).not.toHaveProperty("model");
    expect(body).not.toHaveProperty("effort");
  });

  it("Shift+↵ is a newline and ↵ during IME composition sends nothing", async () => {
    const calls = api({ [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi")] }) });
    renderChat();
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
    renderChat();
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
    renderChat("zh");
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
    renderChat();
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
    renderChat();
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

  it("rename from the title menu PATCHes and shows the title; changed: title refetches it", async () => {
    let title: string | null = null;
    const calls = api({
      [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi")] }),
      [`GET ${BASE}`]: () => json(200, CONV("c1", { title })),
      [`PATCH ${BASE}`]: (c) => {
        title = (bodyOf(c) as { title: string }).title;
        return json(200, CONV("c1", { title, titleSource: "manual" }));
      },
    });
    const changed = vi.fn();
    window.addEventListener("cap:conversations-changed", changed);
    renderChat();
    await screen.findByText("hi");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^Untitled conversation/ }));
    await user.click(await screen.findByRole("menuitem", { name: en.chat.rename }));
    const field = await screen.findByRole("textbox", { name: "Title" });
    await user.type(field, "Quarterly numbers{Enter}");
    await vi.waitFor(() => expect(calls.find((c) => c.method === "PATCH")).toBeTruthy());
    expect(bodyOf(calls.find((c) => c.method === "PATCH"))).toEqual({ title: "Quarterly numbers" });
    expect(await screen.findByRole("button", { name: /Quarterly numbers/ })).toBeTruthy();
    expect(changed).toHaveBeenCalled();
    title = "Generated title";
    act(() => FakeEventSource.instances[0]?.emit("changed", { what: "title" }));
    expect(await screen.findByRole("button", { name: /Generated title/ })).toBeTruthy();
    window.removeEventListener("cap:conversations-changed", changed);
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
    const changed = vi.fn();
    window.addEventListener("cap:conversations-changed", changed);
    renderChat();
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
    // the sidebar heard of the new title even though the first answer was superseded
    expect(changed).toHaveBeenCalled();
    window.removeEventListener("cap:conversations-changed", changed);
  });

  it("a title generated before the stream opened still reaches the title bar and the sidebar", async () => {
    let title: string | null = null;
    api({
      [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi")] }),
      [`GET ${BASE}`]: () => json(200, CONV("c1", { title })),
    });
    const changed = vi.fn();
    window.addEventListener("cap:conversations-changed", changed);
    renderChat();
    await screen.findByText("hi");
    await screen.findByRole("button", { name: /^Untitled conversation/ });
    // generated (and its `changed: title` sent) before the stream was open
    title = "Generated early";
    act(() => FakeEventSource.instances[0]?.emit("open"));
    expect(await screen.findByRole("button", { name: /Generated early/ })).toBeTruthy();
    await vi.waitFor(() => expect(changed).toHaveBeenCalled());
    window.removeEventListener("cap:conversations-changed", changed);
  });

  it("Retry on the failed divider re-sends the last message with retryOf", async () => {
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
    renderChat();
    const retry = await screen.findByRole("button", { name: "Retry" });
    await userEvent.setup().click(retry);
    expect(bodyOf(posts(calls, `${BASE}/messages`)[0])).toMatchObject({
      text: "hello",
      retryOf: 1,
    });
    // The retry folds into the divider instead of a second bubble.
    await vi.waitFor(() => expect(screen.getAllByText("hello")).toHaveLength(1));
    expect(document.querySelector('[data-divider="failed"]')?.textContent).toMatch(/Retried/);
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
    renderChat();
    await screen.findByText("again");
    expect(document.querySelector('[data-divider="hook-denied"]')?.textContent).toContain(
      en.errors.run.hook_denied.replace("{plugin}", "guard"),
    );
    const pinned = document.querySelector('[data-divider="failed"]')?.textContent ?? "";
    expect(pinned).toContain(en.errors.run.pinned_unavailable);
    expect(pinned).toContain('Pinned skill "notes" cannot be read');
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
    renderChat();
    await screen.findByText("answer");
    await vi.waitFor(() => expect(screen.queryByText(/^Thought for/)).toBeNull());
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
    const r = renderChat();
    expect(await screen.findByText("queued in one")).toBeTruthy();
    await userEvent.setup().type(input(), "draft for one");
    params.conversationId = "c2";
    r.rerender(
      <NextIntlClientProvider locale="en" messages={en}>
        <DesignProvider locale="en" link={Link as LinkComponent}>
          <ToastProvider>
            <ChatPageInSession />
          </ToastProvider>
        </DesignProvider>
      </NextIntlClientProvider>,
    );
    expect(await screen.findByText("in two")).toBeTruthy();
    expect(screen.queryByText("queued in one")).toBeNull();
    expect(screen.queryByText("in one")).toBeNull();
    expect(input()).toHaveProperty("value", "");
  });
});

import { SessionContext } from "../src/components/shell/session";

function ChatPageInSession() {
  return (
    <SessionContext.Provider value={{ me: ME, reload: async () => {}, switchOrg: async () => {} }}>
      <ChatPage />
    </SessionContext.Provider>
  );
}

describe("a new conversation (/chat)", () => {
  it("?agent= picks the agent; the first send creates the conversation and replaces the URL", async () => {
    search.set("agent", "ag2");
    resetNavigation("/chat");
    const calls = stubApi({
      "GET /api/v1/orgs/o1/agents": () => json(200, AGENTS),
      "GET /api/v1/orgs/o1/models": () => json(200, MODELS),
      "GET /api/v1/orgs/o1/conversations/groups": () => json(200, { groups: [], next: null }),
      "POST /api/v1/orgs/o1/conversations": () =>
        json(201, { ...CONV("c9", { agentId: "ag2" }), event: userMsg(1, "start") }),
    });
    renderPage(<NewChatPage />, { locale: "en" });
    expect(await screen.findByRole("heading", { name: "Second agent" })).toBeTruthy();
    // Nothing is created before the first send.
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    await userEvent.setup().type(input(), "start{Enter}");
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith("/chat/c9"));
    expect(bodyOf(calls.find((c) => c.method === "POST"))).toMatchObject({
      agentId: "ag2",
      message: { text: "start" },
    });
  });

  it("without ?agent= the agent most recently talked to is picked, and can be changed", async () => {
    resetNavigation("/chat");
    stubApi({
      "GET /api/v1/orgs/o1/agents": () => json(200, AGENTS),
      "GET /api/v1/orgs/o1/models": () => json(200, MODELS),
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
    renderPage(<NewChatPage />, { locale: "en" });
    expect(await screen.findByRole("heading", { name: "Second agent" })).toBeTruthy();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: `${en.chat.pickAgent}: Second agent` }));
    await user.click(await screen.findByRole("menuitemradio", { name: /Echo agent/ }));
    expect(await screen.findByRole("heading", { name: "Echo agent" })).toBeTruthy();
  });
});

describe("the conversation page in the app frame", () => {
  const twoOrgs = (currentOrgId: string) => ({
    ...ME,
    currentOrgId,
    memberships: [...ME.memberships, { orgId: "o2", slug: "b", name: "Beta", role: "member" }],
  });

  it("switching org goes back to /agents and never reads the conversation with the new org", async () => {
    let current = "o1";
    const calls = api({
      "GET /api/v1/me": () => json(200, twoOrgs(current)),
      "PUT /api/v1/me/current-org": () => {
        current = "o2";
        return new Response(null, { status: 204 });
      },
      [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi")] }),
    });
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <DesignProvider locale="en" link={Link as LinkComponent}>
          <ToastProvider>
            <AppFrame version="v0">
              <ChatPage />
            </AppFrame>
          </ToastProvider>
        </DesignProvider>
      </NextIntlClientProvider>,
    );
    await screen.findByText("hi");
    // The page draws its own status bar with the version.
    expect(screen.getAllByText("v0").length).toBeGreaterThan(0);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^Account: .* · Acme$/ }));
    await user.click(await screen.findByRole("menuitemradio", { name: "Beta" }));
    await vi.waitFor(() => expect(router.push).toHaveBeenCalledWith("/agents"));
    expect(
      calls.some(
        (c) =>
          c.url.includes("/orgs/o2/") &&
          !c.url.includes("/orgs/o2/inbox") &&
          !c.url.includes("/orgs/o2/ui/contributions") &&
          !c.url.includes("/orgs/o2/conversations/groups"),
      ),
    ).toBe(false);
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
    renderChat();
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
    renderChat();
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
                  name: "slack__search",
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
              key: "slack__search",
              title: "Search messages",
              kind: "connector",
              keyArgs: ["query"],
              source: { kind: "connector", id: "k1", name: "Slack" },
            },
          ],
        }),
    });
    renderChat("en");
    expect(await screen.findByText(/Slack: Search messages/)).toBeTruthy();
    expect(calls.some((c) => c.url.endsWith("/tools?keys=slack__search"))).toBe(true);
  });
});
