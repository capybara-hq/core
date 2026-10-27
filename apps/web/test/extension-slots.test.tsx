import { act, cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import ChatPage from "../src/app/[locale]/(app)/chat/[conversationId]/page";
import type { UiView } from "../src/lib/ui";
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
import { resetNavigation, router } from "./support/navigation";
import { renderPage } from "./support/render";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("next/navigation", () => ({ useParams: () => ({ conversationId: "c1" }) }));

const ORG = "/api/v1/orgs/o1";
const UI = `${ORG}/ui`;
const BASE = `${ORG}/conversations/c1`;

const PANEL = {
  plugin: "todo",
  id: "tasks-panel",
  title: { zh: "待办", en: "Tasks" },
  place: "panel",
  kind: "view",
  icon: "list-checks",
};
const SECTION = { ...PANEL, id: "tasks-section", place: "section" };
const CARD = { ...PANEL, id: "tasks-card", place: "inline", title: { zh: "待办", en: "todo" } };
const EMBED = {
  plugin: "board",
  id: "live",
  title: { zh: "实时", en: "Live" },
  place: "panel",
  kind: "embed",
  icon: "layout-grid",
};

const view = (text: string): UiView => ({
  badge: "1/3",
  blocks: [{ type: "checklist", items: [{ text, status: "pending" }] }],
});

let contributions: unknown[];

function api(extra: Record<string, (c: Call) => Response | Promise<Response>> = {}) {
  return stubApi({
    [`GET ${BASE}`]: () => json(200, CONV()),
    [`GET ${BASE}/queue`]: () => json(200, { items: [], paused: false }),
    [`GET ${BASE}/files`]: () => json(200, { files: [], next: null }),
    [`GET ${BASE}/sandbox`]: () =>
      json(404, { error: { code: "sandbox.not_found", message: "x" } }),
    [`GET ${BASE}/tools`]: () => json(200, { tools: [] }),
    [`GET ${ORG}/agents`]: () => json(200, AGENTS),
    [`GET ${ORG}/models`]: () => json(200, MODELS),
    [`GET ${ORG}/connectors`]: () => json(200, { connectors: [] }),
    [`GET ${UI}/contributions`]: () => json(200, { items: contributions }),
    ...extra,
  });
}

const withCard = () => [
  userMsg(1, "go"),
  runStarted(2),
  ev(3, "assistant_message", {
    step: 0,
    content: [{ type: "tool_call", id: "call_1", name: "todo__write", input: { todos: [] } }],
    stopReason: "tool_use",
  }),
  ev(4, "tool_result", {
    step: 0,
    callId: "call_1",
    toolKey: "todo__write",
    content: "ok",
    isError: false,
    card: { plugin: "todo", view: "tasks-card" },
  }),
];

beforeEach(() => {
  resetNavigation("/chat/c1");
  window.history.replaceState(null, "", "/chat/c1");
  vi.stubGlobal("EventSource", FakeEventSource);
  contributions = [PANEL, SECTION, CARD];
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  FakeEventSource.instances = [];
});

describe("extension slots fail alone (review focus 3)", () => {
  it("a section whose view times out shows Failed to load · Retry while the stream keeps updating", async () => {
    let fail = true;
    api({
      [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi"), runStarted(2)] }),
      [`GET ${UI}/views/todo/tasks-section`]: () =>
        fail
          ? json(504, { error: { code: "ui.timeout", message: "x" } })
          : json(200, { view: view("Later") }),
    });
    window.history.replaceState(null, "", "/chat/c1#properties");
    renderPage(<ChatPage />, { locale: "zh" });
    expect(await screen.findByText("待办 加载失败")).toBeTruthy();
    expect(screen.getByText(/没有及时响应|did not respond/)).toBeTruthy();
    const es = FakeEventSource.instances[0] as FakeEventSource;
    act(() => {
      es.emit("delta", { runId: "r1", step: 0, delta: "text", text: "still " });
      es.emit("delta", { runId: "r1", step: 0, delta: "text", text: "streaming" });
    });
    expect(await screen.findByText("still streaming")).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "消息" })).toHaveProperty("disabled", false);
    fail = false;
    const section = screen.getByText("待办 加载失败").closest("section") as HTMLElement;
    await userEvent.setup().click(within(section).getByRole("button", { name: "重试" }));
    expect(await screen.findByText("Later")).toBeTruthy();
  });

  it("an inline card under its tool call loads with the callId; its failure stays in the card", async () => {
    const calls = api({
      [`GET ${BASE}/events`]: () => json(200, { events: withCard() }),
      [`GET ${UI}/views/todo/tasks-card`]: () =>
        json(502, { error: { code: "ui.render_failed", message: "x" } }),
    });
    renderPage(<ChatPage />, { locale: "en" });
    const card = await vi.waitFor(() => {
      const el = document.querySelector('[data-extension-card="todo/tasks-card"]');
      if (!el) throw new Error("no card");
      return el as HTMLElement;
    });
    expect(await within(card).findByText("todo failed to load")).toBeTruthy();
    expect(within(card).getByText(en.errors.ui.render_failed)).toBeTruthy();
    const get = calls.find((c) => c.url.startsWith(`${UI}/views/todo/tasks-card`));
    expect(new URL(get?.url ?? "", "http://x").searchParams.get("callId")).toBe("call_1");
    // The thread around it renders.
    expect(screen.getByText("go")).toBeTruthy();
  });

  it("an extension disabled meanwhile loses its icon, section and cards on the next refresh", async () => {
    api({
      [`GET ${BASE}/events`]: () => json(200, { events: withCard() }),
      [`GET ${UI}/views/todo/tasks-card`]: () => json(200, { view: view("Card task") }),
      [`GET ${UI}/views/todo/tasks-section`]: () => json(200, { view: view("Section task") }),
    });
    window.history.replaceState(null, "", "/chat/c1#properties");
    renderPage(<ChatPage />, { locale: "en" });
    expect(await screen.findByText("Card task")).toBeTruthy();
    expect(await screen.findByText("Section task")).toBeTruthy();
    const bar = document.querySelector('[data-part="title-bar"]') as HTMLElement;
    expect(within(bar).getByRole("button", { name: "Tasks" })).toBeTruthy();
    contributions = [];
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await vi.waitFor(() => expect(screen.queryByText("Card task")).toBeNull());
    expect(screen.queryByText("Section task")).toBeNull();
    expect(within(bar).queryByRole("button", { name: "Tasks" })).toBeNull();
  });
});

describe("embed panels (tier two)", () => {
  const issued = (src: string) =>
    json(200, {
      token: "tok-1",
      src,
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      expiresIn: 300,
    });

  it("token with conversationId, a sandboxed iframe, init after load, navigate / toast / resize", async () => {
    contributions = [EMBED];
    const calls = api({
      [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi")] }),
      [`POST ${UI}/embeds/board/live/token`]: () => issued("/plugin-ui/board/live"),
    });
    window.history.replaceState(null, "", "/chat/c1#panel=board/live");
    renderPage(<ChatPage />, { locale: "en" });
    const frame = await vi.waitFor(() => {
      const f = document.querySelector('iframe[title="Live"]');
      if (!f) throw new Error("no iframe yet");
      return f as HTMLIFrameElement;
    });
    expect(frame.getAttribute("src")).toBe("/plugin-ui/board/live");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
    const post = calls.find((c) => c.url === `${UI}/embeds/board/live/token`);
    expect(bodyOf(post)).toEqual({ conversationId: "c1" });
    const win = frame.contentWindow as Window;
    const sent: unknown[] = [];
    vi.spyOn(win, "postMessage").mockImplementation((m: unknown) => {
      sent.push(m);
    });
    act(() => {
      frame.dispatchEvent(new Event("load"));
    });
    expect(sent).toEqual([
      expect.objectContaining({ type: "init", context: { orgId: "o1", conversationId: "c1" } }),
    ]);
    const fromFrame = (data: unknown) =>
      act(() => {
        window.dispatchEvent(new MessageEvent("message", { data, source: win }));
      });
    // The frame's message listener is a passive effect, which may run after the frame shows up
    // (late under load): a resize answered first proves messages reach the bridge.
    await vi.waitFor(() => {
      fromFrame({ protocol: "capybara-embed/1", type: "resize", height: 640 });
      expect(frame.getAttribute("height")).toBe("640");
    });
    fromFrame({ protocol: "capybara-embed/1", type: "navigate", path: "https://evil.example" });
    expect(router.push).not.toHaveBeenCalled();
    fromFrame({ protocol: "capybara-embed/1", type: "navigate", path: "/chat/c9" });
    expect(router.push).toHaveBeenCalledWith("/chat/c9");
    fromFrame({ protocol: "capybara-embed/1", type: "toast", text: "Card added" });
    expect(await screen.findByText("Card added")).toBeTruthy();
  });

  it("a failing token shows Failed to load · Retry in the panel only; retry opens it", async () => {
    contributions = [EMBED];
    let fail = true;
    api({
      [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi")] }),
      [`POST ${UI}/embeds/board/live/token`]: () =>
        fail
          ? json(404, { error: { code: "ui.not_found", message: "x" } })
          : issued("/plugin-ui/board/live"),
    });
    window.history.replaceState(null, "", "/chat/c1#panel=board/live");
    renderPage(<ChatPage />, { locale: "en" });
    const panel = await screen.findByRole("complementary", { name: "Live" });
    expect(await within(panel).findByText(en.errors.ui.not_found)).toBeTruthy();
    expect(screen.getByText("hi")).toBeTruthy();
    fail = false;
    await userEvent.setup().click(within(panel).getByRole("button", { name: "Retry" }));
    expect(await within(panel).findByTitle("Live")).toBeTruthy();
  });

  it("an embed page that keeps navigating away stops after 3 remounts with Retry", async () => {
    contributions = [EMBED];
    api({
      [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi")] }),
      [`POST ${UI}/embeds/board/live/token`]: () => issued("/plugin-ui/board/live"),
    });
    window.history.replaceState(null, "", "/chat/c1#panel=board/live");
    renderPage(<ChatPage />, { locale: "en" });
    const panel = await screen.findByRole("complementary", { name: "Live" });
    let prev: HTMLIFrameElement | undefined;
    for (let i = 0; i < 4; i++) {
      const f = await vi.waitFor(() => {
        const el = within(panel).getByTitle("Live") as HTMLIFrameElement;
        if (el === prev) throw new Error("not remounted yet");
        return el;
      });
      prev = f;
      act(() => {
        f.dispatchEvent(new Event("load"));
      });
      act(() => {
        f.dispatchEvent(new Event("load"));
      });
    }
    expect(await within(panel).findByText(en.ui.embedRemountLimit)).toBeTruthy();
    await userEvent.setup().click(within(panel).getByRole("button", { name: "Retry" }));
    expect(await within(panel).findByTitle("Live")).toBeTruthy();
  });
});
