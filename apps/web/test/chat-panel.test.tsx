import { DesignProvider, type LinkComponent, ToastProvider } from "@capybara-hq/design";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import PluginPage from "../src/app/[locale]/(app)/p/[plugin]/[id]/page";
import { EmbedTab } from "../src/components/extension-ui/EmbedTab";
import { AppFrame } from "../src/components/shell/AppFrame";
import { RequireSession } from "../src/components/shell/session";
import type { UiView } from "../src/lib/ui";
import { bodyOf, json, stubApi } from "./support/api";
import { Link, resetNavigation } from "./support/navigation";
import { ME, renderPage } from "./support/render";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
const params = vi.hoisted(() => ({ current: {} as Record<string, string> }));
vi.mock("next/navigation", () => ({ useParams: () => params.current }));

const _msgs = { zh, en } as const;
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
const _convStream = () =>
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
const _userMsg = (seq: number, text: string) =>
  ev(seq, "user_message", { content: [{ type: "text", text }], authorAccountId: "a1" }, null);
const _runStarted = (seq: number) =>
  ev(seq, "run_started", { agentVersion: 1, model: { provider: "model-fake", model: "fake-1" } });
const _toolCall = (seq: number, id: string, name: string, input: unknown) =>
  ev(seq, "assistant_message", {
    step: 0,
    content: [{ type: "tool_call", id, name, input }],
    stopReason: "tool_use",
  });
const _toolResult = (seq: number, callId: string, toolKey: string, content: string, extra = {}) =>
  ev(seq, "tool_result", { step: 0, callId, toolKey, content, isError: false, ...extra });

const TASKS = {
  plugin: "todo",
  id: "tasks",
  title: { zh: "任务", en: "Tasks" },
  place: "panel",
  legacyPlace: "conversation",
  kind: "view",
  icon: "list-checks",
};
// a section and an inline card are not tabs of this panel
const _TASKS_SECTION = { ...TASKS, id: "tasks-section", place: "section" };
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
  place: "panel",
  kind: "embed",
  icon: "layout-grid",
};

const _tasksView = (done: number, total: number): UiView => ({
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
const _tabNamed = (name: RegExp | string) =>
  within(panelOf()).getByRole("tab", { name: typeof name === "string" ? new RegExp(name) : name });

describe("the sidebar's Extensions group", () => {
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
  const nav = () => screen.getByRole("navigation", { name: "Main navigation" });

  it("is hidden without page contributions", async () => {
    const calls = stubApi({
      "GET /api/v1/me": () => json(200, ME),
      [`GET ${ORG}/approvals`]: () => json(200, { approvals: [] }),
      [`GET ${UI}/contributions`]: () => json(200, { items: [TASKS, EMBED] }),
    });
    renderFrame();
    await screen.findByText("page body");
    await vi.waitFor(() => expect(calls.some((c) => c.url === `${UI}/contributions`)).toBe(true));
    await new Promise((r) => setTimeout(r, 20));
    expect(within(nav()).queryByText("Extensions")).toBeNull();
  });

  it("lists the pages by title, linking to /p/<plugin>/<id>; a shared title gets its plugin", async () => {
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
            { ...BOARD_PAGE, plugin: "crm", id: "board" },
          ],
        }),
    });
    renderFrame();
    expect(await within(nav()).findByText("Extensions")).toBeTruthy();
    const links = within(nav())
      .getAllByRole("link")
      .filter((l) => (l.getAttribute("href") ?? "").startsWith("/p/"));
    expect(links.map((l) => [l.textContent, l.getAttribute("href")])).toEqual([
      ["Board · board", "/p/board/overview"],
      ["Deals", "/p/crm/deals"],
      ["Live", "/p/board/live"],
      ["Board · crm", "/p/crm/board"],
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
    expect(await screen.findByText(`${en.errors.ui.render_failed}`)).toBeTruthy();
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
