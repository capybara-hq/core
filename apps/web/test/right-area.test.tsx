import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import { formatRightHash, parseRightHash } from "../src/lib/right-area";
import type { UiView } from "../src/lib/ui";
import { type Call, json, stubApi } from "./support/api";
import {
  AGENTS,
  CONV,
  envView,
  ev,
  FakeEventSource,
  MODELS,
  renderChatRoute,
  userMsg,
} from "./support/conversation";
import { resetNavigation } from "./support/navigation";

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
  slot: "conversation.panel",
  kind: "view",
  icon: "list-checks",
};
export const TODO_SECTION = {
  ...TODO_PANEL,
  id: "tasks-section",
  slot: "conversation.properties.section",
};

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
    [`GET ${conv(id)}/environment`]: () => json(200, { environment: null }),
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
      { kind: "background", taskId: "bt_abc234" },
    ] as const) {
      expect(parseRightHash(formatRightHash(t))).toEqual(t);
    }
    expect(parseRightHash("#panel=todo")).toBeNull();
    expect(parseRightHash("#nope=1")).toBeNull();
    expect(formatRightHash({ kind: "background", taskId: "bt_abc234" })).toBe("#bg-bt_abc234");
    expect(parseRightHash("#bg-")).toBeNull();
    expect(parseRightHash("")).toBeNull();
    expect(formatRightHash(null)).toBe("");
  });

  it("#agents=<id>/transcript round-trips", () => {
    for (const t of [
      { kind: "agents" },
      { kind: "agents", id: "c 2" },
      { kind: "agents", id: "c2", transcript: true },
    ] as const) {
      expect(parseRightHash(formatRightHash(t))).toEqual(t);
    }
    expect(formatRightHash({ kind: "agents" })).toBe("#agents");
    expect(formatRightHash({ kind: "agents", id: "c2", transcript: true })).toBe(
      "#agents=c2/transcript",
    );
    expect(parseRightHash("#agents=c2/transcript")).toEqual({
      kind: "agents",
      id: "c2",
      transcript: true,
    });
    expect(parseRightHash("#agents=c2/nope")).toBeNull();
    expect(parseRightHash("#agents=/transcript")).toBeNull();
  });
});

describe("the right area", () => {
  it("properties and one panel exclude each other; the open icon is pressed; the hash follows", async () => {
    api();
    await renderChatRoute();
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

  it("each title-bar toggle opens the panel its name says; nothing is listed twice", async () => {
    api();
    await renderChatRoute();
    await screen.findByText("in c1");
    const user = userEvent.setup();
    const bar = document.querySelector('[data-part="title-bar"]') as HTMLElement;
    const toggles = within(bar)
      .getAllByRole("button")
      .filter((b) => b.getAttribute("data-part") === "title-bar-button");
    // Properties, Files and the extension's panel; all fit, so there is no More
    expect(toggles.map((b) => b.getAttribute("aria-label"))).toEqual([
      "Properties",
      en.chat.files,
      "Tasks",
    ]);
    const expected: Record<string, { hash: string; panel: string }> = {
      Properties: { hash: "#properties", panel: "Properties" },
      [en.chat.files]: { hash: "#file=f1", panel: "out.txt" },
      Tasks: { hash: "#panel=todo/tasks-panel", panel: "Tasks" },
    };
    for (const [name, want] of Object.entries(expected)) {
      const button = within(bar).getByRole("button", { name });
      if (button.getAttribute("aria-pressed") === "true") await user.click(button);
      await user.click(within(bar).getByRole("button", { name }));
      expect(window.location.hash).toBe(want.hash);
      expect(await screen.findByRole("complementary", { name: want.panel })).toBeTruthy();
      expect(within(bar).getByRole("button", { name }).getAttribute("aria-pressed")).toBe("true");
    }
  });

  it("without files there is no Files toggle (it would open something else)", async () => {
    api("c1", {
      [`GET ${conv("c1")}/files`]: () => json(200, { files: [], next: null }),
      [`GET ${UI}/contributions`]: () => json(200, { items: [] }),
    });
    await renderChatRoute();
    await screen.findByText("in c1");
    const bar = document.querySelector('[data-part="title-bar"]') as HTMLElement;
    expect(within(bar).queryByRole("button", { name: en.chat.files })).toBeNull();
    expect(within(bar).queryByRole("button", { name: "More" })).toBeNull();
    expect(bar.querySelector('[data-part="title-bar-separator"]')).toBeNull();
    expect(within(bar).getByRole("button", { name: "Properties" })).toBeTruthy();
  });

  it("a section item with an open target opens the panel with the item", async () => {
    const calls = api();
    window.history.replaceState(null, "", "/chat/c1#properties");
    await renderChatRoute();
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
    await renderChatRoute();
    const panel = await screen.findByRole("complementary", { name: "out.txt" });
    expect(await within(panel).findByText("hello")).toBeTruthy();
  });

  it("another conversation never shows the previous one's panel", async () => {
    api("c1");
    window.history.replaceState(null, "", "/chat/c1#panel=todo/tasks-panel");
    const r = await renderChatRoute();
    expect(await screen.findByRole("complementary", { name: "Tasks" })).toBeTruthy();
    // Navigating to /chat/c2 (a URL without the hash) remounts the page for c2.
    cleanup();
    void r;
    api("c2");
    params.conversationId = "c2";
    window.history.replaceState(null, "", "/chat/c2");
    await renderChatRoute({ id: "c2" });
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
    await renderChatRoute();
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
                    name: "Bash",
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
                toolKey: "Bash",
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
    await renderChatRoute();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Bash/ }));
    await user.click(await screen.findByRole("button", { name: "View full text" }));
    const panel = await screen.findByRole("complementary", { name: "Full output" });
    expect(await within(panel).findByText("the whole output")).toBeTruthy();
    expect(window.location.hash).toBe("#output=call_1");
  });
});

describe("the Context section's sandbox status", () => {
  const toolInfo = (key: string, sandbox: boolean) => ({
    key,
    title: null,
    kind: sandbox ? "command" : "tool",
    sandbox,
    keyArgs: [],
    source: { kind: "builtin" },
  });
  const result = (seq: number, toolKey: string) =>
    ev(seq, "tool_result", { step: 0, callId: `c${seq}`, toolKey, content: "ok", isError: false });

  it("existing sandbox calls do not reload on first load; a later Deliver result does", async () => {
    const calls = api("c1", {
      [`GET ${conv("c1")}/events`]: () =>
        json(200, { events: [userMsg(1, "go"), result(2, "Bash")] }),
      [`GET ${conv("c1")}/tools`]: (c) => {
        const keys = (new URL(c.url, "http://x").searchParams.get("keys") ?? "").split(",");
        return json(200, {
          tools: keys.map((k) => toolInfo(k, k === "Bash" || k === "Deliver")),
        });
      },
    });
    const sandboxGets = () => calls.filter((c) => c.url.endsWith("/c1/environment")).length;
    const { calls: server } = await renderChatRoute();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Properties" }));
    // the first paint has the sandbox status and the tool info from the server snapshot
    expect(server.some((c) => c.url.endsWith("/c1/environment"))).toBe(true);
    await waitFor(() =>
      expect([...server, ...calls].some((c) => c.url.includes("/c1/tools?keys=Bash"))).toBe(true),
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    const before = sandboxGets();
    // the existing Bash result is the baseline: no reread on the first load
    expect(before).toBe(0);

    act(() => {
      FakeEventSource.instances[0]?.emit("event", result(3, "Deliver"));
    });
    await waitFor(() => expect(sandboxGets()).toBe(before + 1));
  });

  it("a sandbox result while the properties panel is closed still rereads the environment", async () => {
    const calls = api("c1", {
      [`GET ${conv("c1")}/events`]: () => json(200, { events: [userMsg(1, "go")] }),
      [`GET ${conv("c1")}/tools`]: (c) => {
        const keys = (new URL(c.url, "http://x").searchParams.get("keys") ?? "").split(",");
        return json(200, { tools: keys.map((k) => toolInfo(k, k === "Write")) });
      },
    });
    const sandboxGets = () => calls.filter((c) => c.url.endsWith("/c1/environment")).length;
    await renderChatRoute();
    expect(screen.queryByRole("complementary", { name: "Properties" })).toBeNull();
    // the first delivered event ends the catch-up, which rereads everything outside the log once
    act(() => {
      FakeEventSource.instances[0]?.emit("event", userMsg(2, "again"));
    });
    await waitFor(() => expect(sandboxGets()).toBe(1));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    const before = sandboxGets();
    act(() => {
      FakeEventSource.instances[0]?.emit("event", result(3, "Write"));
    });
    // the panel is not open: the conversation page itself keeps the environment current, so a
    // panel opened later shows the started instance instead of a fresh but outdated state
    await waitFor(() => expect(sandboxGets()).toBe(before + 1));
  });
});

describe("the conversation's environment (environments design §4.1 item 2)", () => {
  const T = "2026-11-07T08:00:00.000Z";
  const open = async () => {
    window.history.replaceState(null, "", "/chat/c1#properties");
    await renderChatRoute();
    return screen.findByRole("complementary", { name: "Properties" });
  };
  const bound = (environment: unknown, environmentId: string | null = "e1") =>
    api("c1", {
      [`GET ${conv("c1")}`]: () => json(200, CONV("c1", { environmentId })),
      [`GET ${conv("c1")}/environment`]: () => json(200, { environment }),
    });

  it("properties panel shows the conversation's environment", async () => {
    bound(envView("e1", null, { instance: { status: "running", lastUsedAt: T } }));
    const props = await open();
    expect(
      within(props).getByText(
        `Environment: ${en.environments.personal} · ${en.environments.state.running}`,
        { exact: false },
      ),
    ).toBeTruthy();
    // the composer shows it read only, before the model
    expect(
      screen.getByText(en.environments.personal, { selector: '[data-part="picker"]' }),
    ).toBeTruthy();
  });

  it("an environment that is not started or whose provider is gone shows that state", async () => {
    bound(envView("e1", "Build box"));
    expect(within(await open()).getByText(/Build box · Not started/)).toBeTruthy();
    cleanup();
    bound(envView("e1", "Build box", { available: false }));
    expect(within(await open()).getByText(/Build box · Unavailable/)).toBeTruthy();
  });

  it("a bound environment that was deleted shows 环境已删除, not 'none'", async () => {
    bound(null);
    const props = await open();
    expect(within(props).getByText(en.chatPanel.environmentDeleted, { exact: false })).toBeTruthy();
    expect(
      screen.getByText(en.chat.environmentDeleted, { selector: '[data-part="picker"]' }),
    ).toBeTruthy();
  });

  it("a row read before its first tool call bound it still shows the bound environment", async () => {
    // the row says unbound, the environment route (read after the first tool call) has one
    bound(envView("e1", "Build box"), null);
    await open();
    expect(await screen.findByText("Build box", { selector: '[data-part="picker"]' })).toBeTruthy();
  });

  it("a conversation with no environment bound says so and shows no picker", async () => {
    bound(null, null);
    const props = await open();
    expect(within(props).getByText(en.chatPanel.environmentNone, { exact: false })).toBeTruthy();
    expect(document.querySelector('[data-part="picker"][data-locked="true"]')).toBeNull();
  });
});
