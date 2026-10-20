import { DesignProvider, type LinkComponent, ToastProvider } from "@capybara-hq/design";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import ChatPage from "../src/app/[locale]/(app)/chat/[conversationId]/page";
import PluginPage from "../src/app/[locale]/(app)/p/[plugin]/[id]/page";
import { AppFrame } from "../src/components/shell/AppFrame";
import { RequireSession } from "../src/components/shell/session";
import type { UiView } from "../src/lib/ui";
import { bodyOf, json, stubApi } from "./support/api";
import { Link, resetNavigation } from "./support/navigation";
import { ME, renderPage } from "./support/render";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
const params = vi.hoisted(() => ({ current: {} as Record<string, string> }));
vi.mock("next/navigation", () => ({ useParams: () => params.current }));

const msgs = { zh, en } as const;
const ORG = "/api/v1/orgs/o1";
const BASE = `${ORG}/conversations/c1`;
const UI = `${ORG}/ui`;

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly listeners = new Map<string, ((e: Event) => void)[]>();
  readyState = 1;
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: Event) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {
    this.readyState = 2;
  }
  emit(type: string, data?: unknown) {
    const e =
      data === undefined ? new Event(type) : new MessageEvent(type, { data: JSON.stringify(data) });
    for (const fn of this.listeners.get(type) ?? []) fn(e);
  }
}
const convStream = () =>
  FakeEventSource.instances.find((s) => s.url.startsWith(`${BASE}/stream`)) as FakeEventSource;

function ev(seq: number, type: string, payload: unknown, runId: string | null = "r1") {
  return {
    conversationId: "c1",
    seq,
    type,
    payload,
    runId,
    createdAt: new Date(seq * 1000).toISOString(),
  };
}
const userMsg = (seq: number, text: string) =>
  ev(seq, "user_message", { content: [{ type: "text", text }], authorAccountId: "a1" }, null);
const runStarted = (seq: number) =>
  ev(seq, "run_started", { agentVersion: 1, model: { provider: "model-fake", model: "fake-1" } });
const toolCall = (seq: number, id: string, name: string, input: unknown) =>
  ev(seq, "assistant_message", {
    step: 0,
    content: [{ type: "tool_call", id, name, input }],
    stopReason: "tool_use",
  });
const toolResult = (seq: number, callId: string, toolKey: string, content: string, extra = {}) =>
  ev(seq, "tool_result", { step: 0, callId, toolKey, content, isError: false, ...extra });

const TASKS = {
  plugin: "todo",
  id: "tasks",
  title: { zh: "任务", en: "Tasks" },
  place: "conversation",
  kind: "view",
};
const BOARD_PAGE = {
  plugin: "board",
  id: "overview",
  title: { zh: "看板", en: "Board" },
  place: "page",
  kind: "view",
};
const EMBED = {
  plugin: "board",
  id: "live",
  title: { zh: "实时", en: "Live" },
  place: "conversation",
  kind: "embed",
};

const tasksView = (done: number, total: number): UiView => ({
  badge: `${done}/${total}`,
  blocks: [
    {
      type: "checklist",
      items: Array.from({ length: total }, (_, i) => ({
        text: `task ${i + 1}`,
        status: i < done ? "completed" : "pending",
      })),
    },
  ],
});

beforeEach(() => {
  resetNavigation("/chat/c1");
  params.current = { conversationId: "c1" };
  vi.stubGlobal("EventSource", FakeEventSource);
  try {
    localStorage.clear();
  } catch {}
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  FakeEventSource.instances = [];
});

const panelOf = () => screen.getByRole("complementary");
const tabNamed = (name: RegExp | string) =>
  within(panelOf()).getByRole("tab", { name: typeof name === "string" ? new RegExp(name) : name });

describe("对话页右侧标签面板", () => {
  it("插件对话视图排在前面，带 badge；收到 event: ui 后重新取数（带 conversationId 与 locale）", async () => {
    let view = tasksView(1, 2);
    const calls = stubApi({
      [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi")] }),
      [`GET ${UI}/contributions`]: () => json(200, { items: [TASKS, EMBED] }),
      [`GET ${UI}/views/todo/tasks`]: () => json(200, { view }),
    });
    renderPage(<ChatPage />, { locale: "zh" });
    const tab = await within(panelOf()).findByRole("tab", { name: /任务/ });
    await vi.waitFor(() => expect(tab.textContent).toContain("1/2"));
    const tabs = within(panelOf()).getAllByRole("tab");
    expect(tabs.map((t) => t.textContent?.replace(/1\/2/, ""))).toEqual([
      "任务",
      zh.chatPanel.run,
      zh.chatPanel.context,
    ]);
    // 第一个标签默认选中，显示清单
    expect(tab.getAttribute("aria-selected")).toBe("true");
    expect(within(panelOf()).getByText("task 1")).toBeTruthy();
    const viewCall = calls.find((c) => c.url.startsWith(`${UI}/views/todo/tasks`));
    expect(viewCall?.url).toBe(`${UI}/views/todo/tasks?conversationId=c1&locale=zh`);

    view = tasksView(2, 2);
    act(() => convStream().emit("ui", { plugin: "todo", contribution: "tasks" }));
    await vi.waitFor(() => expect(tabNamed("任务").textContent).toContain("2/2"));
    // 别的插件 / 贡献的刷新不触发重取
    const before = calls.filter((c) => c.url.includes("/ui/views/")).length;
    act(() => convStream().emit("ui", { plugin: "other", contribution: "x" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.filter((c) => c.url.includes("/ui/views/")).length).toBe(before);
  });

  it("插件视图取数失败：只有那个标签显示错误与「重试」，对话照常（审查重点 1）", async () => {
    let fail = true;
    stubApi({
      [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hello there")] }),
      [`GET ${UI}/contributions`]: () => json(200, { items: [TASKS] }),
      [`GET ${UI}/views/todo/tasks`]: () =>
        fail
          ? json(504, { error: { code: "ui.timeout", message: "timeout" } })
          : json(200, { view: tasksView(0, 1) }),
    });
    renderPage(<ChatPage />, { locale: "en" });
    const panel = panelOf();
    expect(await within(panel).findByText(`✗ ${en.errors.ui.timeout}`)).toBeTruthy();
    // 对话流不受影响，也没有页面级错误
    expect(screen.getByText("hello there")).toBeTruthy();
    expect(screen.getAllByText(`✗ ${en.errors.ui.timeout}`)).toHaveLength(1);
    const composer = screen.getByLabelText(en.chat.inputLabel).closest("form") as HTMLElement;
    expect(within(composer).queryByText(`✗ ${en.errors.ui.timeout}`)).toBeNull();
    // 其他标签照常
    const user = userEvent.setup();
    await user.click(tabNamed(en.chatPanel.run));
    expect(within(panel).queryByText(`✗ ${en.errors.ui.timeout}`)).toBeNull();
    expect(within(panel).getByText(en.chatPanel.runEmpty)).toBeTruthy();
    // 回到失败的标签点「重试」
    await user.click(tabNamed("Tasks"));
    fail = false;
    await user.click(within(panel).getByRole("button", { name: en.common.retry }));
    expect(await within(panel).findByText("task 1")).toBeTruthy();
    expect(within(panel).queryByText(`✗ ${en.errors.ui.timeout}`)).toBeNull();
  });

  it("插件视图的动作：POST 带 actionId / payload / conversationId / locale；返回 view 直接替换，toast 弹出", async () => {
    const withButtons: UiView = {
      badge: "0/1",
      blocks: [
        {
          type: "actions",
          buttons: [
            { actionId: "clear", label: "Clear", payload: { scope: "done" } },
            { actionId: "ping", label: "Ping" },
          ],
        },
      ],
    };
    const calls = stubApi({
      [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi")] }),
      [`GET ${UI}/contributions`]: () => json(200, { items: [TASKS] }),
      [`GET ${UI}/views/todo/tasks`]: () => json(200, { view: withButtons }),
      [`POST ${UI}/actions/todo/tasks`]: (c) =>
        (bodyOf(c) as { actionId: string }).actionId === "clear"
          ? json(200, { view: { badge: "0/0", blocks: [{ type: "heading", text: "All clear" }] } })
          : json(200, { toast: { zh: "已发送", en: "Sent" } }),
    });
    renderPage(<ChatPage />, { locale: "en" });
    const user = userEvent.setup();
    await user.click(await within(panelOf()).findByRole("button", { name: "Ping" }));
    expect(await screen.findByText("Sent")).toBeTruthy();
    await user.click(within(panelOf()).getByRole("button", { name: "Clear" }));
    expect(await within(panelOf()).findByRole("heading", { name: "All clear" })).toBeTruthy();
    expect(tabNamed("Tasks").textContent).toContain("0/0");
    const post = calls.find(
      (c) => c.method === "POST" && (bodyOf(c) as { actionId: string }).actionId === "clear",
    );
    expect(bodyOf(post)).toEqual({
      actionId: "clear",
      payload: { scope: "done" },
      conversationId: "c1",
      locale: "en",
    });
    expect(post?.headers.get("x-capybara-csrf")).toBe("1");
  });

  it("记住最后选中的标签（localStorage cap.chat.panelTab）；有待批准的操作时「运行」带提醒", async () => {
    stubApi({
      [`GET ${BASE}/events`]: () =>
        json(200, {
          events: [
            userMsg(1, "go"),
            runStarted(2),
            toolCall(3, "call_1", "fixture__delete_item", { id: "x1" }),
            ev(4, "approval_requested", {
              step: 0,
              callId: "call_1",
              approvalId: "ap1",
              toolKey: "fixture__delete_item",
              expiresAt: "2026-10-19T12:00:00.000Z",
            }),
          ],
        }),
      [`GET ${UI}/contributions`]: () => json(200, { items: [] }),
      [`GET ${ORG}/approvals/ap1`]: () => json(404, { error: { code: "approval.not_found" } }),
    });
    renderPage(<ChatPage />, { locale: "en" });
    const run = await within(panelOf()).findByRole("tab", { name: new RegExp(en.chatPanel.run) });
    expect(run.querySelector('[data-alert="true"]')).not.toBeNull();
    await userEvent.setup().click(tabNamed(en.chatPanel.context));
    expect(localStorage.getItem("cap.chat.panelTab")).toBe("context");
    cleanup();
    renderPage(<ChatPage />, { locale: "en" });
    const context = await within(panelOf()).findByRole("tab", {
      name: new RegExp(en.chatPanel.context),
    });
    expect(context.getAttribute("aria-selected")).toBe("true");
  });

  it("localStorage 不可用时照常显示（取值 / 存值都包在 try/catch 里）", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    });
    stubApi({
      [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi")] }),
      [`GET ${UI}/contributions`]: () => json(200, { items: [] }),
    });
    renderPage(<ChatPage />, { locale: "en" });
    const ctx = await within(panelOf()).findByRole("tab", {
      name: new RegExp(en.chatPanel.context),
    });
    await userEvent.setup().click(ctx);
    expect(ctx.getAttribute("aria-selected")).toBe("true");
  });

  it("运行标签列出工具调用，点开显示完整 IN / OUT；存档的输出给出存档 id", async () => {
    const long = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
    stubApi({
      [`GET ${BASE}/events`]: () =>
        json(200, {
          events: [
            userMsg(1, "go"),
            runStarted(2),
            toolCall(3, "call_1", "fixture__search", { q: "capybara" }),
            ev(4, "tool_call_started", {
              step: 0,
              callId: "call_1",
              toolKey: "fixture__search",
              specHash: "h",
            }),
            toolResult(5, "call_1", "fixture__search", long, { outputId: "out_9" }),
          ],
        }),
      [`GET ${UI}/contributions`]: () => json(200, { items: [] }),
    });
    renderPage(<ChatPage />, { locale: "en" });
    const panel = panelOf();
    await within(panel).findByRole("tab", { name: new RegExp(en.chatPanel.run) });
    const row = await within(panel).findByRole("button", { name: /fixture__search/ });
    const user = userEvent.setup();
    await user.click(row);
    expect(within(panel).getByText("IN")).toBeTruthy();
    expect(within(panel).getByText(/"q": "capybara"/)).toBeTruthy();
    expect(within(panel).getByText(en.tools.outputId.replace("{id}", "out_9"))).toBeTruthy();
    // 时间线里对应的那一行保持折叠
    const log = screen.getByRole("log");
    expect(within(log).getByRole("button", { name: /fixture__search/ }).ariaExpanded).toBe("false");
  });

  it("上下文标签：最近一次 usage 对模型上下文窗口、agent / 模型、用到的应用、压缩记录", async () => {
    stubApi({
      [`GET ${BASE}/events`]: () =>
        json(200, {
          events: [
            userMsg(1, "go"),
            runStarted(2),
            ev(3, "model_call", { step: 0, provider: "model-fake", model: "fake-1" }),
            toolCall(4, "call_1", "fixture__search", { q: "capybara" }),
            toolResult(5, "call_1", "fixture__search", "3 results"),
            ev(6, "usage", {
              step: 0,
              provider: "model-fake",
              model: "fake-1",
              inputTokens: 1000,
              outputTokens: 200,
              cacheReadTokens: 800,
              cacheWriteTokens: 0,
            }),
            ev(7, "compaction_summary", { coversUpToSeq: 5, text: "Earlier: searched." }, null),
          ],
        }),
      [`GET ${BASE}`]: () =>
        json(200, { conversation: { id: "c1", orgId: "o1", agentId: "ag1", lastSeq: 7 } }),
      [`GET ${ORG}/agents`]: () =>
        json(200, { agents: [{ id: "ag1", definition: { name: "Echo agent" } }] }),
      [`GET ${ORG}/models`]: () =>
        json(200, {
          providers: [
            {
              provider: "model-fake",
              models: [
                {
                  id: "fake-1",
                  displayName: "Fake 1",
                  contextWindow: 10000,
                  capabilities: { reasoning: false },
                  parameters: [],
                },
              ],
            },
          ],
        }),
      [`GET ${ORG}/apps`]: () =>
        json(200, { apps: [{ id: "app1", slug: "fixture", name: "Fixture", status: "active" }] }),
      [`GET ${UI}/contributions`]: () => json(200, { items: [] }),
    });
    renderPage(<ChatPage />, { locale: "en" });
    const user = userEvent.setup();
    await user.click(
      await within(panelOf()).findByRole("tab", { name: new RegExp(en.chatPanel.context) }),
    );
    const panel = panelOf();
    expect(await within(panel).findByText("Echo agent")).toBeTruthy();
    expect(within(panel).getByText("model-fake/fake-1")).toBeTruthy();
    expect(within(panel).getByText("c1")).toBeTruthy();
    expect(
      await within(panel).findByText(
        en.chatPanel.tokensOf
          .replace("{used}", "2,000")
          .replace("{total}", "10,000")
          .replace("{pct}", "20"),
      ),
    ).toBeTruthy();
    expect(await within(panel).findByText("Fixture")).toBeTruthy();
    expect(within(panel).getByText(/Earlier: searched\./)).toBeTruthy();
  });
});

describe("对话时间线", () => {
  it.each(["zh", "en"] as const)(
    "工具调用行：标题取 display.summary[locale]，没有时退回「工具名 + 输入前几个字段」（%s）",
    async (locale) => {
      stubApi({
        [`GET ${BASE}/events`]: () =>
          json(200, {
            events: [
              userMsg(1, "go"),
              runStarted(2),
              toolCall(3, "call_1", "todo__write", { todos: [] }),
              toolResult(4, "call_1", "todo__write", "ok", {
                display: {
                  summary: { zh: "更新任务清单（2 项）", en: "Updated task list (2 items)" },
                },
              }),
              toolCall(5, "call_2", "fixture__delete_item", { id: "x1", reason: "cleanup", n: 3 }),
            ],
          }),
        [`GET ${UI}/contributions`]: () => json(200, { items: [] }),
      });
      renderPage(<ChatPage />, { locale });
      const log = await screen.findByRole("log");
      const summary = locale === "zh" ? "更新任务清单（2 项）" : "Updated task list (2 items)";
      const todo = (await within(log).findByText("todo__write")).closest(
        '[data-role="tool"]',
      ) as HTMLElement;
      expect(within(todo).getByText(summary)).toBeTruthy();
      expect(todo.getAttribute("data-status")).toBe("done");
      const del = within(log)
        .getByText("fixture__delete_item")
        .closest('[data-role="tool"]') as HTMLElement;
      expect(within(del).getByText("id: x1 · reason: cleanup")).toBeTruthy();
      expect(del.getAttribute("data-status")).toBe("pending");
      // 默认折叠：展开后才有 IN / OUT
      expect(within(todo).queryByText("IN")).toBeNull();
      await userEvent.setup().click(within(todo).getByRole("button"));
      expect(within(todo).getByText("ok")).toBeTruthy();
      expect(msgs[locale]).toBeTruthy();
    },
  );
});

describe("顶栏「扩展」菜单", () => {
  function renderFrame() {
    return render(
      <NextIntlClientProvider locale="en" messages={en}>
        <DesignProvider locale="en" link={Link as LinkComponent}>
          <ToastProvider>
            <AppFrame version="v0">
              <RequireSession>
                <p>page body</p>
              </RequireSession>
            </AppFrame>
          </ToastProvider>
        </DesignProvider>
      </NextIntlClientProvider>,
    );
  }

  it("没有页面贡献时不出现", async () => {
    const calls = stubApi({
      "GET /api/v1/me": () => json(200, ME),
      [`GET ${ORG}/approvals`]: () => json(200, { approvals: [] }),
      [`GET ${UI}/contributions`]: () => json(200, { items: [TASKS, EMBED] }),
    });
    renderFrame();
    await screen.findByText("page body");
    await vi.waitFor(() => expect(calls.some((c) => c.url === `${UI}/contributions`)).toBe(true));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("button", { name: /Extensions/ })).toBeNull();
  });

  it("有页面贡献时出现，菜单项按插件分组，指向 /p/<plugin>/<id>", async () => {
    stubApi({
      "GET /api/v1/me": () => json(200, ME),
      [`GET ${ORG}/approvals`]: () => json(200, { approvals: [] }),
      [`GET ${UI}/contributions`]: () =>
        json(200, {
          items: [
            BOARD_PAGE,
            TASKS,
            { ...BOARD_PAGE, plugin: "crm", id: "deals", title: { zh: "商机", en: "Deals" } },
            { ...BOARD_PAGE, id: "live", kind: "embed", title: { zh: "实时", en: "Live" } },
          ],
        }),
    });
    renderFrame();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Extensions/ }));
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((i) => [i.textContent, i.getAttribute("href")])).toEqual([
      ["board · Board", "/p/board/overview"],
      ["crm · Deals", "/p/crm/deals"],
    ]);
  });
});

describe("插件页面 /p/<plugin>/<id>", () => {
  it("用 DetailPage（无 Inspector）渲染组织视图；收到组织流的 ui 后重取", async () => {
    params.current = { plugin: "board", id: "overview" };
    let n = 1;
    const calls = stubApi({
      [`GET ${UI}/contributions`]: () => json(200, { items: [BOARD_PAGE] }),
      [`GET ${UI}/views/board/overview`]: () =>
        json(200, { view: { blocks: [{ type: "heading", text: `Cards ${n}` }] } }),
    });
    const { container } = renderPage(<PluginPage />, { locale: "en" });
    expect(await screen.findByRole("heading", { name: "Cards 1" })).toBeTruthy();
    expect(container.querySelector('[data-template="DetailPage"]')).not.toBeNull();
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(screen.getAllByText("Board").length).toBeGreaterThan(0);
    expect(calls.find((c) => c.url.includes("/views/"))?.url).toBe(
      `${UI}/views/board/overview?locale=en`,
    );
    const stream = FakeEventSource.instances.find((s) => s.url === `${UI}/stream`);
    expect(stream).toBeTruthy();
    n = 2;
    act(() => stream?.emit("ui", { plugin: "board", contribution: "overview" }));
    expect(await screen.findByRole("heading", { name: "Cards 2" })).toBeTruthy();
  });

  it("取数失败显示错误与「重试」", async () => {
    params.current = { plugin: "board", id: "overview" };
    stubApi({
      [`GET ${UI}/contributions`]: () => json(200, { items: [BOARD_PAGE] }),
      [`GET ${UI}/views/board/overview`]: () =>
        json(502, { error: { code: "ui.render_failed", message: "x" } }),
    });
    renderPage(<PluginPage />, { locale: "en" });
    expect(await screen.findByText(`✗ ${en.errors.ui.render_failed}`)).toBeTruthy();
    expect(screen.getByRole("button", { name: en.common.retry })).toBeTruthy();
  });
});
