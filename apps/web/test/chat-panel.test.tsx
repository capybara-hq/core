import { DesignProvider, type LinkComponent, ToastProvider } from "@capybara-hq/design";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import ChatPage from "../src/app/[locale]/(app)/chat/[conversationId]/page";
import PluginPage from "../src/app/[locale]/(app)/p/[plugin]/[id]/page";
import { EmbedTab } from "../src/components/chat-panel/EmbedTab";
import { AppFrame } from "../src/components/shell/AppFrame";
import { RequireSession } from "../src/components/shell/session";
import type { UiView } from "../src/lib/ui";
import { bodyOf, json, stubApi } from "./support/api";
import { Link, resetNavigation, router } from "./support/navigation";
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
      "实时",
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

  it("运行标签列出工具调用，点开显示完整 IN / OUT；存档的输出经存档接口取全文", async () => {
    const long = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
    const OUT_ID = "0b6f7c1e-1111-4222-8333-444455556666";
    const full = `${long}\nline 31 (only in the archive)`;
    const calls = stubApi({
      [`GET ${BASE}/outputs/${OUT_ID}`]: (c) => {
        // 按页取：第一页到 next，再取第二页
        const offset = Number(new URL(c.url, "http://x").searchParams.get("offset") ?? "0");
        const half = 50;
        return offset === 0
          ? json(200, {
              output: {
                id: OUT_ID,
                text: full.slice(0, half),
                offset: 0,
                totalChars: full.length,
                next: half,
              },
            })
          : json(200, {
              output: {
                id: OUT_ID,
                text: full.slice(half),
                offset: half,
                totalChars: full.length,
                next: null,
              },
            });
      },
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
            toolResult(5, "call_1", "fixture__search", long, { outputId: OUT_ID }),
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
    expect(within(panel).getByText(en.tools.outputId.replace("{id}", OUT_ID))).toBeTruthy();
    await user.click(within(panel).getByRole("button", { name: "View full output" }));
    // OUT 超过 12 行默认折叠：展开全部后能看到只在存档里的最后一行
    await user.click(await within(panel).findByRole("button", { name: /Expand all \(31 lines\)/ }));
    expect(within(panel).getByText(/line 31 \(only in the archive\)/)).toBeTruthy();
    const pages = calls.filter((c) => c.url.startsWith(`${BASE}/outputs/${OUT_ID}`));
    expect(pages.map((c) => new URL(c.url, "http://x").searchParams.get("offset") ?? "0")).toEqual([
      "0",
      "50",
    ]);
    // 时间线里对应的那一行保持折叠
    const log = screen.getByRole("log");
    expect(within(log).getByRole("button", { name: /fixture__search/ }).ariaExpanded).toBe("false");
  });

  it("「查看全部输出」：在途时连点只取一次、按钮显示读取中；切到别的标签再回来不重取，全文还在", async () => {
    const OUT_ID = "0b6f7c1e-1111-4222-8333-444455556677";
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const calls = stubApi({
      [`GET ${BASE}/outputs/${OUT_ID}`]: (() =>
        gate.then(() =>
          json(200, {
            output: { id: OUT_ID, text: "ARCHIVED FULL", offset: 0, totalChars: 13, next: null },
          }),
        )) as never,
      [`GET ${BASE}/events`]: () =>
        json(200, {
          events: [
            userMsg(1, "go"),
            runStarted(2),
            toolCall(3, "call_1", "fixture__search", { q: "x" }),
            toolResult(4, "call_1", "fixture__search", "preview", { outputId: OUT_ID }),
          ],
        }),
      [`GET ${UI}/contributions`]: () => json(200, { items: [] }),
    });
    renderPage(<ChatPage />, { locale: "en" });
    const panel = panelOf();
    const user = userEvent.setup();
    await user.click(await within(panel).findByRole("button", { name: /fixture__search/ }));
    const showAll = within(panel).getByRole("button", { name: "View full output" });
    await user.click(showAll);
    const loading = within(panel).getByRole("button", { name: en.chatPanel.loadingOutput });
    await user.click(loading);
    await user.click(loading);
    const fetched = () => calls.filter((c) => c.url.startsWith(`${BASE}/outputs/${OUT_ID}`));
    expect(fetched()).toHaveLength(1);
    await act(async () => {
      release();
      await gate;
    });
    expect(await within(panel).findByText("ARCHIVED FULL")).toBeTruthy();

    await user.click(tabNamed(en.chatPanel.context));
    await user.click(tabNamed(en.chatPanel.run));
    await user.click(await within(panel).findByRole("button", { name: /fixture__search/ }));
    expect(within(panel).getByText("ARCHIVED FULL")).toBeTruthy();
    expect(fetched()).toHaveLength(1);
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

describe("对话页右侧标签面板：刷新合并、标签回退与错误提示", () => {
  it("同一视图请求在途时连续收到 8 次 event: ui：最多再发 2 次 GET（在途一次 + 补取一次）（I1）", async () => {
    let n = 0;
    const pending: (() => void)[] = [];
    const calls = stubApi({
      [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi")] }),
      [`GET ${UI}/contributions`]: () => json(200, { items: [TASKS] }),
      [`GET ${UI}/views/todo/tasks`]: (() => {
        n += 1;
        const view = tasksView(n - 1, 9);
        if (n === 1) return json(200, { view });
        return new Promise<Response>((resolve) => {
          pending.push(() => resolve(json(200, { view })));
        });
      }) as unknown as () => Response,
    });
    renderPage(<ChatPage />, { locale: "en" });
    await vi.waitFor(() => expect(tabNamed("Tasks").textContent).toContain("0/9"));
    const viewGets = () => calls.filter((c) => c.url.includes("/ui/views/todo/tasks")).length;
    expect(viewGets()).toBe(1);
    for (let i = 0; i < 8; i++) {
      act(() => convStream().emit("ui", { plugin: "todo", contribution: "tasks" }));
    }
    await vi.waitFor(() => expect(viewGets()).toBe(2));
    // 在途的那次完成后，只补取一次
    await act(async () => pending.shift()?.());
    await vi.waitFor(() => expect(viewGets()).toBe(3));
    await act(async () => pending.shift()?.());
    await vi.waitFor(() => expect(tabNamed("Tasks").textContent).toContain("2/9"));
    await new Promise((r) => setTimeout(r, 20));
    expect(viewGets()).toBe(3);
  });

  it("在途的请求失败、期间又收到 event: ui：仍补取一次，补取成功后显示新视图", async () => {
    let n = 0;
    const pending: ((ok: boolean) => void)[] = [];
    const calls = stubApi({
      [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi")] }),
      [`GET ${UI}/contributions`]: () => json(200, { items: [TASKS] }),
      [`GET ${UI}/views/todo/tasks`]: (() => {
        n += 1;
        const view = tasksView(n - 1, 9);
        if (n === 1) return json(200, { view });
        return new Promise<Response>((resolve) => {
          pending.push((ok) =>
            resolve(ok ? json(200, { view }) : json(502, { error: { code: "ui.render_failed" } })),
          );
        });
      }) as unknown as () => Response,
    });
    renderPage(<ChatPage />, { locale: "en" });
    await vi.waitFor(() => expect(tabNamed("Tasks").textContent).toContain("0/9"));
    const viewGets = () => calls.filter((c) => c.url.includes("/ui/views/todo/tasks")).length;
    act(() => convStream().emit("ui", { plugin: "todo", contribution: "tasks" }));
    await vi.waitFor(() => expect(viewGets()).toBe(2));
    act(() => convStream().emit("ui", { plugin: "todo", contribution: "tasks" }));
    // 在途的那次失败：补取照常发出
    await act(async () => pending.shift()?.(false));
    await vi.waitFor(() => expect(viewGets()).toBe(3));
    await act(async () => pending.shift()?.(true));
    await vi.waitFor(() => expect(tabNamed("Tasks").textContent).toContain("2/9"));
    await new Promise((r) => setTimeout(r, 20));
    expect(viewGets()).toBe(3);
  });

  it("记住的标签不在了（插件被停用等）：回退到「运行」，而不是第一个插件标签（M2）", async () => {
    localStorage.setItem("cap.chat.panelTab", "view:gone/x");
    stubApi({
      [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi")] }),
      [`GET ${UI}/contributions`]: () => json(200, { items: [TASKS] }),
      [`GET ${UI}/views/todo/tasks`]: () => json(200, { view: tasksView(0, 1) }),
    });
    renderPage(<ChatPage />, { locale: "en" });
    await within(panelOf()).findByRole("tab", { name: /Tasks/ });
    await vi.waitFor(() =>
      expect(tabNamed(en.chatPanel.run).getAttribute("aria-selected")).toBe("true"),
    );
    expect(tabNamed("Tasks").getAttribute("aria-selected")).toBe("false");
  });

  it("贡献列表读取失败：面板给出提示与「重试」，重试成功后出现插件标签（M7）", async () => {
    let fail = true;
    stubApi({
      [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi")] }),
      [`GET ${UI}/contributions`]: () =>
        fail
          ? json(500, { error: { code: "internal", message: "x" } })
          : json(200, { items: [TASKS] }),
      [`GET ${UI}/views/todo/tasks`]: () => json(200, { view: tasksView(0, 1) }),
    });
    renderPage(<ChatPage />, { locale: "en" });
    const panel = panelOf();
    expect(await within(panel).findByText(en.chatPanel.contributionsFailed)).toBeTruthy();
    fail = false;
    await userEvent.setup().click(within(panel).getByRole("button", { name: en.common.retry }));
    expect(await within(panel).findByRole("tab", { name: /Tasks/ })).toBeTruthy();
    expect(within(panel).queryByText(en.chatPanel.contributionsFailed)).toBeNull();
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
      // 等待中（尚未开始执行）的调用用空心标记，不用表示进行中的主色标记
      expect(del.closest("li")?.getAttribute("data-mark")).toBe("hollow");
      expect(todo.closest("li")?.getAttribute("data-mark")).toBe("dot");
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
      ["board · Live", "/p/board/live"],
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

  it("连续 8 次组织流 ui：最多 2 次重取（I1）；卸载时关闭组织流（M1）", async () => {
    params.current = { plugin: "board", id: "overview" };
    let n = 0;
    const pending: (() => void)[] = [];
    const calls = stubApi({
      [`GET ${UI}/contributions`]: () => json(200, { items: [BOARD_PAGE] }),
      [`GET ${UI}/views/board/overview`]: (() => {
        n += 1;
        const view = { blocks: [{ type: "heading", text: `Cards ${n}` }] };
        if (n === 1) return json(200, { view });
        return new Promise<Response>((resolve) => {
          pending.push(() => resolve(json(200, { view })));
        });
      }) as unknown as () => Response,
    });
    const { unmount } = renderPage(<PluginPage />, { locale: "en" });
    await screen.findByRole("heading", { name: "Cards 1" });
    const stream = FakeEventSource.instances.find(
      (s) => s.url === `${UI}/stream`,
    ) as FakeEventSource;
    for (let i = 0; i < 8; i++) {
      act(() => stream.emit("ui", { plugin: "board", contribution: "overview" }));
    }
    const gets = () => calls.filter((c) => c.url.includes("/views/board/overview")).length;
    await vi.waitFor(() => expect(gets()).toBe(2));
    await act(async () => pending.shift()?.());
    await vi.waitFor(() => expect(gets()).toBe(3));
    await act(async () => pending.shift()?.());
    expect(await screen.findByRole("heading", { name: "Cards 3" })).toBeTruthy();
    expect(gets()).toBe(3);
    expect(stream.readyState).toBe(1);
    unmount();
    expect(stream.readyState).toBe(2);
  });

  it("组织流出错（如会话被吊销）：页面提示实时刷新已断开（M7）", async () => {
    params.current = { plugin: "board", id: "overview" };
    stubApi({
      [`GET ${UI}/contributions`]: () => json(200, { items: [BOARD_PAGE] }),
      [`GET ${UI}/views/board/overview`]: () =>
        json(200, { view: { blocks: [{ type: "heading", text: "Cards" }] } }),
    });
    renderPage(<PluginPage />, { locale: "en" });
    await screen.findByRole("heading", { name: "Cards" });
    const stream = FakeEventSource.instances.find(
      (s) => s.url === `${UI}/stream`,
    ) as FakeEventSource;
    act(() => stream.emit("error", { code: "auth.session_revoked" }));
    expect(await screen.findByText(en.pluginPage.liveLost)).toBeTruthy();
    // 内容仍在
    expect(screen.getByRole("heading", { name: "Cards" })).toBeTruthy();
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

describe("嵌入应用（第二档）", () => {
  const issued = (src: string) =>
    json(200, {
      token: "tok-1",
      src,
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      expiresIn: 300,
    });

  it("对话标签：取令牌（带 conversationId），沙箱 iframe 打开同源代理地址；加载后发 init，处理 navigate / toast / resize", async () => {
    const calls = stubApi({
      [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi")] }),
      [`GET ${UI}/contributions`]: () => json(200, { items: [EMBED] }),
      [`POST ${UI}/embeds/board/live/token`]: () => issued("/plugin-ui/board/live"),
    });
    renderPage(<ChatPage />, { locale: "en" });
    const tab = await within(panelOf()).findByRole("tab", { name: /Live/ });
    expect(tab.getAttribute("aria-selected")).toBe("true");
    const frame = (await within(panelOf()).findByTitle("Live")) as HTMLIFrameElement;
    expect(frame.tagName).toBe("IFRAME");
    expect(frame.getAttribute("src")).toBe("/plugin-ui/board/live");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    const post = calls.find((c) => c.url === `${UI}/embeds/board/live/token`);
    expect(bodyOf(post)).toEqual({ conversationId: "c1" });
    expect(post?.headers.get("x-capybara-csrf")).toBe("1");

    const win = frame.contentWindow as Window;
    const sent: unknown[] = [];
    vi.spyOn(win, "postMessage").mockImplementation((m: unknown) => {
      sent.push(m);
    });
    act(() => {
      frame.dispatchEvent(new Event("load"));
    });
    expect(sent).toEqual([
      expect.objectContaining({
        protocol: "capybara-embed/1",
        type: "init",
        token: "tok-1",
        locale: "en",
        context: { orgId: "o1", conversationId: "c1" },
      }),
    ]);

    const fromFrame = (data: unknown, source: unknown = win) =>
      act(() => {
        window.dispatchEvent(new MessageEvent("message", { data, source: source as Window }));
      });
    // 别的 window 发来的、站外跳转：忽略
    fromFrame({ protocol: "capybara-embed/1", type: "navigate", path: "/chat/c9" }, window);
    fromFrame({ protocol: "capybara-embed/1", type: "navigate", path: "https://evil.example" });
    fromFrame({ protocol: "capybara-embed/1", type: "navigate", path: "//evil.example" });
    expect(router.push).not.toHaveBeenCalled();
    fromFrame({ protocol: "capybara-embed/1", type: "navigate", path: "/chat/c9" });
    expect(router.push).toHaveBeenCalledWith("/chat/c9");
    fromFrame({ protocol: "capybara-embed/1", type: "toast", text: "Card added" });
    expect(await screen.findByText("Card added")).toBeTruthy();
    fromFrame({ protocol: "capybara-embed/1", type: "resize", height: 640 });
    await vi.waitFor(() => expect(frame.getAttribute("height")).toBe("640"));
  });

  it("iframe 第二次 load（嵌入页导航走了）：不再给它发消息，在原 src 上重新挂载 iframe 后再发 init", async () => {
    stubApi({
      [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi")] }),
      [`GET ${UI}/contributions`]: () => json(200, { items: [EMBED] }),
      [`POST ${UI}/embeds/board/live/token`]: () => issued("/plugin-ui/board/live"),
    });
    renderPage(<ChatPage />, { locale: "en" });
    const first = (await within(panelOf()).findByTitle("Live")) as HTMLIFrameElement;
    const sent1: unknown[] = [];
    vi.spyOn(first.contentWindow as Window, "postMessage").mockImplementation((m: unknown) => {
      sent1.push(m);
    });
    act(() => {
      first.dispatchEvent(new Event("load"));
    });
    expect(sent1).toHaveLength(1);
    act(() => {
      first.dispatchEvent(new Event("load"));
    });
    expect(sent1).toHaveLength(1);
    const second = await vi.waitFor(() => {
      const f = within(panelOf()).getByTitle("Live") as HTMLIFrameElement;
      if (f === first) throw new Error("not remounted yet");
      return f;
    });
    expect(second.getAttribute("src")).toBe("/plugin-ui/board/live");
    expect(second.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
    const sent2: unknown[] = [];
    vi.spyOn(second.contentWindow as Window, "postMessage").mockImplementation((m: unknown) => {
      sent2.push(m);
    });
    act(() => {
      second.dispatchEvent(new Event("load"));
    });
    expect(sent2).toEqual([expect.objectContaining({ type: "init" })]);
  });

  it("StrictMode 下（开发模式会重复挂 ref）：第一次 load 仍只发一次 init，不会误判为导航走了", async () => {
    stubApi({
      [`GET ${UI}/contributions`]: () => json(200, { items: [] }),
      [`POST ${UI}/embeds/board/live/token`]: () => issued("/plugin-ui/board/live"),
    });
    const { container } = render(
      <StrictMode>
        <NextIntlClientProvider locale="en" messages={en}>
          <DesignProvider locale="en" link={Link as LinkComponent}>
            <ToastProvider>
              <EmbedTab orgId="o1" plugin="board" id="live" title="Live" />
            </ToastProvider>
          </DesignProvider>
        </NextIntlClientProvider>
      </StrictMode>,
    );
    const frame = await vi.waitFor(() => {
      const f = container.querySelector("iframe");
      if (!f) throw new Error("no iframe yet");
      return f;
    });
    const sent: unknown[] = [];
    vi.spyOn(frame.contentWindow as Window, "postMessage").mockImplementation((m: unknown) => {
      sent.push(m);
    });
    act(() => {
      frame.dispatchEvent(new Event("load"));
    });
    expect(sent).toEqual([expect.objectContaining({ type: "init" })]);
    await new Promise((r) => setTimeout(r, 20));
    expect(container.querySelector("iframe")).toBe(frame);
  });

  it("10 秒内重新挂载超过 3 次（嵌入页反复整页跳转）：停下来显示错误与「重试」，重试后重新打开", async () => {
    stubApi({
      [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi")] }),
      [`GET ${UI}/contributions`]: () => json(200, { items: [EMBED] }),
      [`POST ${UI}/embeds/board/live/token`]: () => issued("/plugin-ui/board/live"),
    });
    renderPage(<ChatPage />, { locale: "en" });
    const panel = panelOf();
    let prev: HTMLIFrameElement | undefined;
    // 第 1 次挂载 + 3 次重新挂载，每个 iframe 都 load 两次（第二次 = 导航走了）
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
    expect(await within(panel).findByText(`✗ ${en.ui.embedRemountLimit}`)).toBeTruthy();
    expect(within(panel).queryByTitle("Live")).toBeNull();
    await userEvent.setup().click(within(panel).getByRole("button", { name: en.common.retry }));
    const again = await within(panel).findByTitle("Live");
    expect(again.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
  });

  it("取令牌失败：只在这个标签显示错误与「重试」，重试后打开", async () => {
    let fail = true;
    stubApi({
      [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi")] }),
      [`GET ${UI}/contributions`]: () => json(200, { items: [EMBED] }),
      [`POST ${UI}/embeds/board/live/token`]: () =>
        fail
          ? json(404, { error: { code: "ui.not_found", message: "x" } })
          : issued("/plugin-ui/board/live"),
    });
    renderPage(<ChatPage />, { locale: "en" });
    const panel = panelOf();
    expect(await within(panel).findByText(`✗ ${en.errors.ui.not_found}`)).toBeTruthy();
    expect(screen.getByText("hi")).toBeTruthy();
    fail = false;
    await userEvent.setup().click(within(panel).getByRole("button", { name: en.common.retry }));
    expect(await within(panel).findByTitle("Live")).toBeTruthy();
  });

  it("组织页面 /p/<plugin>/<id>：kind embed 渲染沙箱 iframe（不带 conversationId，不开组织流）", async () => {
    params.current = { plugin: "board", id: "live" };
    const calls = stubApi({
      [`GET ${UI}/contributions`]: () =>
        json(200, { items: [{ ...EMBED, place: "page", path: "/ui/live" }] }),
      [`POST ${UI}/embeds/board/live/token`]: () => issued("/plugin-ui/board/live"),
    });
    const { container } = renderPage(<PluginPage />, { locale: "en" });
    const frame = await vi.waitFor(() => {
      const f = container.querySelector("iframe");
      if (!f) throw new Error("no iframe yet");
      return f;
    });
    expect(frame.getAttribute("title")).toBe("Live");
    expect(frame.getAttribute("src")).toBe("/plugin-ui/board/live");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
    expect(container.querySelector('[data-template="DetailPage"]')).not.toBeNull();
    expect(bodyOf(calls.find((c) => c.url.includes("/embeds/")))).toEqual({});
    expect(FakeEventSource.instances.find((s) => s.url === `${UI}/stream`)).toBeUndefined();
  });
});
