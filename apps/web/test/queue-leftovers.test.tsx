import { act, cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bodyOf, type Call, json, stubApi } from "./support/api";
import {
  AGENTS,
  CONV,
  FakeEventSource,
  MODELS,
  renderChatRoute,
  runStarted,
  userMsg,
} from "./support/conversation";
import { resetNavigation } from "./support/navigation";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("next/navigation", () => ({ useParams: () => ({ conversationId: "c1" }) }));

const BASE = "/api/v1/orgs/o1/conversations/c1";
const item = (id: string, text: string, position: number) => ({
  id,
  text,
  files: [],
  attachments: [],
  clientMessageId: `cm-${id}`,
  model: null,
  effort: null,
  createdAt: "2026-10-26T06:00:00.000Z",
  position,
});

let queue: { items: ReturnType<typeof item>[]; paused: boolean };

function api(extra: Record<string, (c: Call) => Response | Promise<Response>> = {}) {
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

describe("leftover queued messages (run input spec 2026-11-07 D3)", () => {
  it("show after the thread in order as pending bubbles, with no queue controls", async () => {
    api();
    const { container } = await renderChatRoute({ locale: "zh" });
    await screen.findByText("first queued");
    const left = [...container.querySelectorAll("[data-leftover]")] as HTMLElement[];
    expect(left.map((n) => n.getAttribute("data-leftover"))).toEqual(["q1", "q2"]);
    for (const n of left) {
      expect(n.querySelector('[data-queued="true"]')).not.toBeNull();
      expect(within(n).getByText("待处理")).toBeTruthy();
    }
    for (const name of ["立即发送", "编辑", "删除", "复制"])
      expect(screen.queryByRole("button", { name })).toBeNull();
    expect(screen.queryByRole("group", { name: "排队的消息" })).toBeNull();
  });

  it("↵ while running posts a message, never the queue", async () => {
    let n = 2;
    const calls = api({
      [`POST ${BASE}/messages`]: (c) =>
        json(202, { event: userMsg(++n, String((bodyOf(c) as { text: string }).text)) }),
    });
    await renderChatRoute();
    await screen.findByText("first queued");
    const input = screen.getByRole("textbox", { name: "Message", hidden: true });
    await userEvent.setup().type(input, "third{Enter}");
    await vi.waitFor(() =>
      expect(calls.filter((c) => c.method === "POST" && c.url === `${BASE}/messages`)).toHaveLength(
        1,
      ),
    );
    expect(calls.some((c) => c.method === "POST" && c.url.startsWith(`${BASE}/queue`))).toBe(false);
    // the new message is not one of the leftovers
    expect(document.querySelectorAll("[data-leftover]")).toHaveLength(2);
  });

  it("a leftover the stream delivers leaves in the same tick: its text shows once", async () => {
    api();
    await renderChatRoute();
    await screen.findByText("first queued");
    // the queue's read still lists it: only the log says it was sent
    act(() =>
      FakeEventSource.instances[0]?.emit(
        "event",
        userMsg(3, "first queued", { clientMessageId: "cm-q1" }),
      ),
    );
    expect(document.querySelector('[data-leftover="q1"]')).toBeNull();
    expect(screen.getAllByText("first queued")).toHaveLength(1);
    expect(
      screen.getByText("first queued").closest("[data-entry]")?.getAttribute("data-entry"),
    ).toBe("user");
    expect(document.querySelector('[data-leftover="q2"]')).not.toBeNull();
  });

  it("reloads on changed: queue (the dispatcher sent one)", async () => {
    api();
    await renderChatRoute();
    await screen.findByText("first queued");
    queue = { items: [item("q2", "second queued", 2)], paused: false };
    act(() => FakeEventSource.instances[0]?.emit("changed", { what: "queue" }));
    await vi.waitFor(() => expect(screen.queryByText("first queued")).toBeNull());
    expect(screen.getByText("second queued")).toBeTruthy();
  });

  it("paused leftovers keep Continue sending (the only way they drain), which resumes", async () => {
    queue = { ...queue, paused: true };
    const calls = api({
      [`POST ${BASE}/queue/resume`]: () => {
        queue = { ...queue, paused: false };
        return json(202, {});
      },
    });
    await renderChatRoute({ locale: "zh" });
    expect(await screen.findByText("运行已停止，队列已暂停（2 条）")).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: "继续发送" }));
    expect(calls.some((c) => c.method === "POST" && c.url === `${BASE}/queue/resume`)).toBe(true);
    await vi.waitFor(() => expect(screen.queryByRole("button", { name: "继续发送" })).toBeNull());
    expect(document.querySelectorAll("[data-leftover]")).toHaveLength(2);
  });

  it("no leftovers: nothing after the thread", async () => {
    queue = { items: [], paused: true };
    api();
    const { container } = await renderChatRoute();
    await screen.findByText("hi");
    expect(container.querySelector("[data-leftover]")).toBeNull();
    expect(screen.queryByRole("button", { name: "Continue sending" })).toBeNull();
  });
});
