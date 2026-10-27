import { act, cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ChatPage from "../src/app/[locale]/(app)/chat/[conversationId]/page";
import { type Call, json, noContent, stubApi } from "./support/api";
import { AGENTS, CONV, FakeEventSource, MODELS, runStarted, userMsg } from "./support/conversation";
import { resetNavigation } from "./support/navigation";
import { renderPage } from "./support/render";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("next/navigation", () => ({ useParams: () => ({ conversationId: "c1" }) }));

const BASE = "/api/v1/orgs/o1/conversations/c1";
const item = (id: string, text: string, position: number) => ({
  id,
  text,
  files: [],
  attachments: [],
  clientMessageId: `cm-${id}`,
  createdAt: "2026-10-26T06:00:00.000Z",
  position,
});

let queue: { items: ReturnType<typeof item>[]; paused: boolean };

function api(extra: Record<string, (c: Call) => Response> = {}) {
  return stubApi({
    [`GET ${BASE}`]: () => json(200, CONV()),
    "GET /api/v1/orgs/o1/agents": () => json(200, AGENTS),
    "GET /api/v1/orgs/o1/models": () => json(200, MODELS),
    [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi"), runStarted(2)] }),
    [`GET ${BASE}/queue`]: () => json(200, queue),
    ...extra,
  });
}

beforeEach(() => {
  resetNavigation("/chat/c1");
  vi.stubGlobal("EventSource", FakeEventSource);
  queue = { items: [item("q1", "first queued", 1), item("q2", "second queued", 2)], paused: false };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  FakeEventSource.instances = [];
});

describe("queued messages", () => {
  it("show under the thread in order, with copy / edit / delete / Send now", async () => {
    const calls = api({
      [`POST ${BASE}/queue/q2/send`]: () => {
        queue = { ...queue, items: [queue.items[0] as ReturnType<typeof item>] };
        return json(202, { event: userMsg(3, "second queued") });
      },
      [`DELETE ${BASE}/queue/q1`]: () => {
        queue = { ...queue, items: [] };
        return noContent();
      },
    });
    renderPage(<ChatPage />, { locale: "zh" });
    const list = await screen.findByRole("group", { name: "排队的消息" });
    const bubbles = within(list).getAllByText(/queued$/);
    expect(bubbles.map((b) => b.textContent)).toEqual(["first queued", "second queued"]);
    const second = list.querySelector('[data-queue-item="q2"]') as HTMLElement;
    const user = userEvent.setup();
    await user.click(within(second).getByRole("button", { name: "立即发送" }));
    expect(calls.some((c) => c.method === "POST" && c.url === `${BASE}/queue/q2/send`)).toBe(true);
    // Sent now: an interjection in the thread, gone from the queue.
    await vi.waitFor(() => expect(list.querySelector('[data-queue-item="q2"]')).toBeNull());
    expect(
      screen.getByText("second queued").closest("[data-entry]")?.getAttribute("data-entry"),
    ).toBe("user");
    const first = list.querySelector('[data-queue-item="q1"]') as HTMLElement;
    await user.click(within(first).getByRole("button", { name: "删除" }));
    await vi.waitFor(() => expect(screen.queryByRole("group", { name: "排队的消息" })).toBeNull());
  });

  it("edits in place: PATCH with the new text", async () => {
    const calls = api({
      [`PATCH ${BASE}/queue/q1`]: () => {
        queue = { ...queue, items: [item("q1", "edited", 1), ...queue.items.slice(1)] };
        return json(200, { item: item("q1", "edited", 1) });
      },
    });
    renderPage(<ChatPage />, { locale: "en" });
    const list = await screen.findByRole("group", { name: "Queued messages" });
    const first = list.querySelector('[data-queue-item="q1"]') as HTMLElement;
    const user = userEvent.setup();
    await user.click(within(first).getByRole("button", { name: "Edit" }));
    const box = within(first).getByRole("textbox");
    await user.clear(box);
    await user.type(box, "edited");
    await user.click(within(first).getByRole("button", { name: "Save" }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(JSON.parse(String(calls.find((c) => c.method === "PATCH")?.body))).toEqual({
      text: "edited",
    });
    expect(await screen.findByText("edited")).toBeTruthy();
  });

  it("a paused queue shows Continue sending, which resumes", async () => {
    queue = { ...queue, paused: true };
    const calls = api({
      [`POST ${BASE}/queue/resume`]: () => {
        queue = { ...queue, paused: false };
        return json(202, {});
      },
    });
    renderPage(<ChatPage />, { locale: "zh" });
    expect(await screen.findByText("运行已停止，队列已暂停（2 条）")).toBeTruthy();
    // Paused bubbles carry no actions.
    expect(screen.queryByRole("button", { name: "立即发送" })).toBeNull();
    await userEvent.setup().click(screen.getByRole("button", { name: "继续发送" }));
    expect(calls.some((c) => c.method === "POST" && c.url === `${BASE}/queue/resume`)).toBe(true);
    await vi.waitFor(() =>
      expect(screen.getAllByRole("button", { name: "立即发送" })).toHaveLength(2),
    );
  });

  it("reloads on changed: queue (another tab or the dispatcher changed it)", async () => {
    api();
    renderPage(<ChatPage />, { locale: "en" });
    await screen.findByText("first queued");
    queue = { items: [item("q2", "second queued", 2)], paused: false };
    act(() => FakeEventSource.instances[0]?.emit("changed", { what: "queue" }));
    await vi.waitFor(() => expect(screen.queryByText("first queued")).toBeNull());
    expect(screen.getByText("second queued")).toBeTruthy();
  });
});
