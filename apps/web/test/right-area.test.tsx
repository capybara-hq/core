import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ChatPage from "../src/app/[locale]/(app)/chat/[conversationId]/page";
import { formatRightHash, parseRightHash } from "../src/lib/right-area";
import type { UiView } from "../src/lib/ui";
import { type Call, json, stubApi } from "./support/api";
import { AGENTS, CONV, FakeEventSource, MODELS, userMsg } from "./support/conversation";
import { resetNavigation } from "./support/navigation";
import { renderPage } from "./support/render";

const params = { conversationId: "c1" };
vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("next/navigation", () => ({ useParams: () => params }));

const ORG = "/api/v1/orgs/o1";
const UI = `${ORG}/ui`;
const conv = (id: string) => `${ORG}/conversations/${id}`;

export const TODO_PANEL = {
  plugin: "todo",
  id: "tasks-panel",
  title: { zh: "待办", en: "Tasks" },
  place: "panel",
  kind: "view",
  icon: "list-checks",
};
export const TODO_SECTION = { ...TODO_PANEL, id: "tasks-section", place: "section" };

const sectionView: UiView = {
  badge: "1/2",
  blocks: [
    {
      type: "checklist",
      items: [
        { text: "Draft", status: "completed", id: "t1" },
        {
          text: "Review",
          status: "pending",
          id: "t2",
          open: { contribution: "tasks-panel", item: "t2" },
        },
      ],
    },
  ],
};
const panelView: UiView = {
  blocks: [
    {
      type: "checklist",
      items: [
        { text: "Draft", status: "completed", id: "t1" },
        { text: "Review", status: "pending", id: "t2" },
      ],
    },
  ],
};

function api(id = "c1", extra: Record<string, (c: Call) => Response> = {}) {
  return stubApi({
    [`GET ${conv(id)}`]: () => json(200, CONV(id)),
    [`GET ${conv(id)}/events`]: () => json(200, { events: [userMsg(1, `in ${id}`)] }),
    [`GET ${conv(id)}/queue`]: () => json(200, { items: [], paused: false }),
    [`GET ${conv(id)}/files`]: () =>
      json(200, {
        files: [
          {
            id: "f1",
            name: "out.txt",
            contentType: "text/plain",
            size: 5,
            sourcePath: "/w/out.txt",
            version: 1,
            versions: [{ id: "f1", size: 5, createdAt: "2026-10-26T06:00:00.000Z" }],
            callId: "c",
            createdAt: "2026-10-26T06:00:00.000Z",
            status: "available",
            previewable: "text",
          },
        ],
        next: null,
      }),
    [`GET ${conv(id)}/files/f1/previewers`]: () => json(200, { previewers: [] }),
    [`GET ${conv(id)}/files/f1/content`]: () =>
      new Response("hello", { status: 200, headers: { "content-type": "text/plain" } }),
    [`GET ${conv(id)}/sandbox`]: () =>
      json(404, { error: { code: "sandbox.not_found", message: "x" } }),
    "GET /api/v1/orgs/o1/agents": () => json(200, AGENTS),
    "GET /api/v1/orgs/o1/models": () => json(200, MODELS),
    "GET /api/v1/orgs/o1/connectors": () => json(200, { connectors: [] }),
    [`GET ${UI}/contributions`]: () => json(200, { items: [TODO_PANEL, TODO_SECTION] }),
    [`GET ${UI}/views/todo/tasks-section`]: () => json(200, { view: sectionView }),
    [`GET ${UI}/views/todo/tasks-panel`]: () => json(200, { view: panelView }),
    ...extra,
  });
}

beforeEach(() => {
  params.conversationId = "c1";
  resetNavigation("/chat/c1");
  window.history.replaceState(null, "", "/chat/c1");
  vi.stubGlobal("EventSource", FakeEventSource);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  FakeEventSource.instances = [];
});

describe("right-area hash", () => {
  it("round-trips every target and rejects junk", () => {
    for (const t of [
      { kind: "properties" },
      { kind: "panel", plugin: "todo", contribution: "tasks-panel" },
      { kind: "panel", plugin: "todo", contribution: "tasks-panel", item: "a/b c" },
      { kind: "file", id: "f 1" },
      { kind: "output", callId: "call_1" },
      { kind: "subagent", id: "s1" },
    ] as const) {
      expect(parseRightHash(formatRightHash(t))).toEqual(t);
    }
    expect(parseRightHash("#panel=todo")).toBeNull();
    expect(parseRightHash("#nope=1")).toBeNull();
    expect(parseRightHash("")).toBeNull();
    expect(formatRightHash(null)).toBe("");
  });
});

describe("the right area", () => {
  it("properties and one panel exclude each other; the open icon is pressed; the hash follows", async () => {
    api();
    renderPage(<ChatPage />, { locale: "en" });
    await screen.findByText("in c1");
    const user = userEvent.setup();
    const props = screen.getByRole("button", { name: "Properties" });
    await user.click(props);
    expect(props.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("complementary", { name: "Properties" })).toBeTruthy();
    expect(window.location.hash).toBe("#properties");

    await user.click(await screen.findByRole("button", { name: "Tasks" }));
    expect(await screen.findByRole("complementary", { name: "Tasks" })).toBeTruthy();
    expect(screen.queryByRole("complementary", { name: "Properties" })).toBeNull();
    const bar = document.querySelector('[data-part="title-bar"]') as HTMLElement;
    expect(within(bar).getByRole("button", { name: "Tasks" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(props.getAttribute("aria-pressed")).toBe("false");
    expect(window.location.hash).toBe("#panel=todo/tasks-panel");
  });

  it("a section item with an open target opens the panel with the item", async () => {
    const calls = api();
    window.history.replaceState(null, "", "/chat/c1#properties");
    renderPage(<ChatPage />, { locale: "en" });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Review" }));
    const panel = await screen.findByRole("complementary", { name: "Tasks" });
    await within(panel).findByText("Review");
    expect(window.location.hash).toBe("#panel=todo/tasks-panel/t2");
    const get = calls.find((c) => c.url.startsWith(`${UI}/views/todo/tasks-panel`));
    expect(new URL(get?.url ?? "", "http://x").searchParams.get("item")).toBe("t2");
    expect(new URL(get?.url ?? "", "http://x").searchParams.get("conversationId")).toBe("c1");
    expect(panel.querySelector('[data-ui-item="t2"]')).not.toBeNull();
  });

  it("#file=<id> survives a reload: the file panel opens from the hash", async () => {
    api();
    window.history.replaceState(null, "", "/chat/c1#file=f1");
    renderPage(<ChatPage />, { locale: "en" });
    const panel = await screen.findByRole("complementary", { name: "out.txt" });
    expect(await within(panel).findByText("hello")).toBeTruthy();
  });

  it("another conversation never shows the previous one's panel", async () => {
    api("c1");
    window.history.replaceState(null, "", "/chat/c1#panel=todo/tasks-panel");
    const r = renderPage(<ChatPage />, { locale: "en" });
    expect(await screen.findByRole("complementary", { name: "Tasks" })).toBeTruthy();
    // Navigating to /chat/c2 (a URL without the hash) remounts the page for c2.
    cleanup();
    void r;
    api("c2");
    params.conversationId = "c2";
    window.history.replaceState(null, "", "/chat/c2");
    renderPage(<ChatPage />, { locale: "en" });
    await screen.findByText("in c2");
    expect(screen.queryByRole("complementary", { name: "Tasks" })).toBeNull();
  });

  it("the Context section shows the context ratio of the latest step", async () => {
    api("c1", {
      [`GET ${conv("c1")}/events`]: () =>
        json(200, {
          events: [
            userMsg(1, "in c1"),
            {
              conversationId: "c1",
              seq: 2,
              type: "usage",
              runId: "r1",
              createdAt: "2026-10-26T06:00:00.000Z",
              payload: {
                step: 0,
                provider: "model-fake",
                model: "fake-1",
                inputTokens: 400,
                outputTokens: 100,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
              },
            },
          ],
        }),
    });
    window.history.replaceState(null, "", "/chat/c1#properties");
    renderPage(<ChatPage />, { locale: "en" });
    const meter = await screen.findByRole("meter", { name: "Context" });
    await vi.waitFor(() => expect(meter.getAttribute("aria-valuenow")).toBe("50"));
    // The status bar shows it too.
    expect(screen.getByText("Context 50%")).toBeTruthy();
  });
});

describe("the output panel", () => {
  it("View all of an archived output opens the full text in the right panel", async () => {
    api("c1", {
      [`GET ${conv("c1")}/events`]: () =>
        json(200, {
          events: [
            userMsg(1, "in c1"),
            {
              conversationId: "c1",
              seq: 2,
              type: "assistant_message",
              runId: "r1",
              createdAt: "2026-10-26T06:00:01.000Z",
              payload: {
                step: 0,
                stopReason: "tool_use",
                content: [
                  {
                    type: "tool_call",
                    id: "call_1",
                    name: "sandbox_bash",
                    input: { command: "cat big" },
                  },
                ],
              },
            },
            {
              conversationId: "c1",
              seq: 3,
              type: "tool_result",
              runId: "r1",
              createdAt: "2026-10-26T06:00:02.000Z",
              payload: {
                step: 0,
                callId: "call_1",
                toolKey: "sandbox_bash",
                content: "head…",
                isError: false,
                outputId: "out1",
              },
            },
          ],
        }),
      [`GET ${conv("c1")}/outputs/out1`]: (c) =>
        c.url.includes("limit=1")
          ? json(200, { output: { id: "out1", text: "h", offset: 0, totalChars: 90_000, next: 1 } })
          : json(200, {
              output: {
                id: "out1",
                text: "the whole output",
                offset: 0,
                totalChars: 16,
                next: null,
              },
            }),
    });
    renderPage(<ChatPage />, { locale: "en" });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /sandbox_bash/ }));
    await user.click(await screen.findByRole("button", { name: "View full text" }));
    const panel = await screen.findByRole("complementary", { name: "Full output" });
    expect(await within(panel).findByText("the whole output")).toBeTruthy();
    expect(window.location.hash).toBe("#output=call_1");
  });
});
