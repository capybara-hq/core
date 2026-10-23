import { DesignProvider, type LinkComponent, ToastProvider } from "@capybara-hq/design";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import ChatPage from "../src/app/[locale]/(app)/chat/[conversationId]/page";
import { AppFrame } from "../src/components/shell/AppFrame";
import { Link, resetNavigation, router } from "./support/navigation";
import { ME, renderPage } from "./support/render";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("next/navigation", () => ({ useParams: () => ({ conversationId: "c1" }) }));

type Call = { url: string; method: string; body: unknown; headers: Headers };

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let seqTime = 0;
function ev(seq: number, type: string, payload: unknown, runId: string | null = "r1") {
  seqTime += 1;
  return {
    conversationId: "c1",
    seq,
    type,
    payload,
    runId,
    createdAt: new Date(seqTime).toISOString(),
  };
}
const userMsg = (seq: number, text: string) =>
  ev(seq, "user_message", { content: [{ type: "text", text }], authorAccountId: "a1" }, null);
const runStarted = (seq: number) =>
  ev(seq, "run_started", {
    agentVersion: 1,
    model: { provider: "model-fake", model: "fake-1" },
    triggerAccountId: "a1",
  });

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
  /** 浏览器放弃重连：readyState → CLOSED 并派发普通 error 事件。 */
  giveUp() {
    this.readyState = 2;
    this.emit("error");
  }
}

/** 按 `METHOD path` 路由的 fetch 桩（path 不含查询串）。 */
function stubApi(routes: Record<string, (call: Call) => Response>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const call = { url, method, body: init?.body, headers: new Headers(init?.headers) };
      calls.push(call);
      const handler = routes[`${method} ${url.split("?")[0]}`];
      if (!handler) throw new Error(`unexpected ${method} ${url}`);
      return handler(call);
    }),
  );
  return calls;
}

const BASE = "/api/v1/orgs/o1/conversations/c1";

function renderChat(locale: "zh" | "en") {
  return renderPage(<ChatPage />, { locale });
}

beforeEach(() => {
  resetNavigation("/chat/c1");
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  FakeEventSource.instances = [];
});

describe("对话页（PlaygroundPage）", () => {
  it("使用 PlaygroundPage：消息在内容区，inspector 显示 agent、会话 ID、运行状态与「停止」", async () => {
    stubApi({
      [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi"), runStarted(2)] }),
      [`GET ${BASE}`]: () =>
        json(200, { conversation: { id: "c1", orgId: "o1", agentId: "ag1", lastSeq: 2 } }),
      "GET /api/v1/orgs/o1/agents": () =>
        json(200, { agents: [{ id: "ag1", definition: { name: "Echo agent" } }] }),
    });
    const { container } = renderChat("en");
    expect(container.querySelector('[data-template="PlaygroundPage"]')).not.toBeNull();
    const inspector = screen.getByRole("complementary");
    expect(await within(inspector).findByText(`● ${en.chat.running}`)).toBeTruthy();
    // agent 与会话 ID 在「上下文」标签
    await userEvent
      .setup()
      .click(within(inspector).getByRole("tab", { name: new RegExp(en.chatPanel.context) }));
    expect(await within(inspector).findByText("Echo agent")).toBeTruthy();
    expect(within(inspector).getByText("c1")).toBeTruthy();
    expect(within(inspector).getByRole("button", { name: en.chat.stop })).toBeTruthy();
    // 输入框旁也有「停止」：任何宽度下一次点击即可停止（inspector 在窄屏收进 Sheet）
    const composer = screen.getByLabelText(en.chat.inputLabel).closest("form") as HTMLElement;
    expect(within(composer).getByRole("button", { name: en.chat.stop })).toBeTruthy();
    expect(screen.getByText("hi").closest("[data-role]")?.getAttribute("data-role")).toBe("user");
  });

  it.each(["zh", "en"] as const)(
    "运行中显示「停止」按钮，点击调用 abort；输入框不禁用（%s）",
    async (locale) => {
      const m = locale === "zh" ? zh : en;
      const calls = stubApi({
        [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi"), runStarted(2)] }),
        [`POST ${BASE}/abort`]: () => json(202, { runId: "r1" }),
      });
      renderChat(locale);
      const [stop] = await screen.findAllByRole("button", { name: m.chat.stop });
      // 历史加载完后从最后一条 seq 开始订阅
      expect(FakeEventSource.instances[0]?.url).toBe(`${BASE}/stream?after=2`);
      expect(screen.getByLabelText(m.chat.inputLabel)).toHaveProperty("disabled", false);

      await userEvent.setup().click(stop as HTMLElement);
      const abort = calls.find((c) => c.method === "POST" && c.url === `${BASE}/abort`);
      expect(abort?.headers.get("x-capybara-csrf")).toBe("1");

      // 运行结束后「停止」按钮消失
      act(() => {
        FakeEventSource.instances[0]?.emit(
          "event",
          ev(3, "run_aborted", { byAccountId: "a1", reason: "user" }),
        );
      });
      expect(screen.queryAllByRole("button", { name: m.chat.stop })).toHaveLength(0);
    },
  );

  it.each(["zh", "en"] as const)(
    "stopReason 为 aborted 的消息带「已停止」标记（%s）",
    async (locale) => {
      const m = locale === "zh" ? zh : en;
      stubApi({
        [`GET ${BASE}/events`]: () =>
          json(200, {
            events: [
              userMsg(1, "hi"),
              runStarted(2),
              ev(3, "assistant_message", {
                step: 0,
                content: [{ type: "text", text: "partial answer" }],
                stopReason: "aborted",
              }),
              ev(4, "run_aborted", { byAccountId: "a1", reason: "user" }),
            ],
          }),
      });
      renderChat(locale);
      const message = (await screen.findByText("partial answer")).closest("[data-role]");
      expect(message).not.toBeNull();
      expect(within(message as HTMLElement).getByText(`⊘ ${m.chat.stopped}`)).toBeTruthy();
      expect(screen.queryAllByRole("button", { name: m.chat.stop })).toHaveLength(0);
    },
  );

  it("流式增量逐步显示，assistant_message 到达后替换草稿", async () => {
    stubApi({
      [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi"), runStarted(2)] }),
    });
    renderChat("en");
    await screen.findAllByRole("button", { name: en.chat.stop });
    const es = FakeEventSource.instances[0] as FakeEventSource;
    act(() => {
      es.emit("delta", { runId: "r1", step: 0, delta: "text", text: "hel" });
      es.emit("delta", { runId: "r1", step: 0, delta: "text", text: "lo" });
    });
    expect(screen.getByText("hello")).toBeTruthy();
    act(() => {
      es.emit(
        "event",
        ev(3, "assistant_message", {
          step: 0,
          content: [{ type: "text", text: "hello world" }],
          stopReason: "end_turn",
        }),
      );
    });
    expect(screen.queryByText("hello")).toBeNull();
    expect(screen.getByText("hello world")).toBeTruthy();
  });

  it("运行中发送即插话：POST messages（带 clientMessageId），返回的事件立即显示", async () => {
    const calls = stubApi({
      [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi"), runStarted(2)] }),
      [`POST ${BASE}/messages`]: (c) => {
        const body = JSON.parse(String(c.body)) as { text: string };
        return json(202, { event: userMsg(3, body.text) });
      },
    });
    renderChat("en");
    await screen.findAllByRole("button", { name: en.chat.stop });
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(en.chat.inputLabel), "echo:interject");
    await user.click(screen.getByRole("button", { name: en.chat.send }));
    const post = calls.find((c) => c.method === "POST" && c.url === `${BASE}/messages`);
    const body = JSON.parse(String(post?.body)) as { text: string; clientMessageId?: string };
    expect(body.text).toBe("echo:interject");
    expect(typeof body.clientMessageId).toBe("string");
    expect(await screen.findByText("echo:interject")).toBeTruthy();
    expect(screen.getByLabelText(en.chat.inputLabel)).toHaveProperty("value", "");
  });

  it("服务端 error 帧：显示翻译后的错误", async () => {
    stubApi({ [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi")] }) });
    renderChat("zh");
    await screen.findByText("hi");
    act(() => {
      FakeEventSource.instances[0]?.emit("error", { code: "auth.session_revoked" });
    });
    expect((await screen.findByRole("alert")).textContent).toBe(
      `✗ ${zh.errors.auth.session_revoked}`,
    );
  });

  it("发送失败后重试沿用同一个 clientMessageId；成功后下一条换新 id", async () => {
    let fail = true;
    let seq = 2;
    const calls = stubApi({
      [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi")] }),
      [`POST ${BASE}/messages`]: (c) => {
        if (fail) {
          fail = false;
          return json(500, { error: { code: "internal", message: "boom" } });
        }
        const body = JSON.parse(String(c.body)) as { text: string };
        seq += 1;
        return json(202, { event: userMsg(seq, body.text) });
      },
    });
    renderChat("en");
    await screen.findByText("hi");
    const user = userEvent.setup();
    const input = screen.getByLabelText(en.chat.inputLabel);
    const send = () => user.click(screen.getByRole("button", { name: en.chat.send }));
    await user.type(input, "first");
    await send(); // 500：保留输入
    expect(input).toHaveProperty("value", "first");
    await send(); // 重试成功
    await screen.findByText("first");
    await user.type(input, "second");
    await send();
    await screen.findByText("second");
    const ids = calls
      .filter((c) => c.method === "POST" && c.url === `${BASE}/messages`)
      .map((c) => (JSON.parse(String(c.body)) as { clientMessageId: string }).clientMessageId);
    expect(ids).toHaveLength(3);
    expect(ids[1]).toBe(ids[0]);
    expect(ids[2]).not.toBe(ids[0]);
  });

  it("失败后改动文本：视为新消息，换新 clientMessageId", async () => {
    const calls = stubApi({
      [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi")] }),
      [`POST ${BASE}/messages`]: () => json(500, { error: { code: "internal", message: "x" } }),
    });
    renderChat("en");
    await screen.findByText("hi");
    const user = userEvent.setup();
    const input = screen.getByLabelText(en.chat.inputLabel);
    const send = () => user.click(screen.getByRole("button", { name: en.chat.send }));
    await user.type(input, "abc");
    await send();
    await user.type(input, "d");
    await send();
    const ids = calls
      .filter((c) => c.method === "POST")
      .map((c) => (JSON.parse(String(c.body)) as { clientMessageId: string }).clientMessageId);
    expect(ids).toHaveLength(2);
    expect(ids[1]).not.toBe(ids[0]);
  });

  it("连接被放弃后重开订阅：after 取事件流送达的最后 seq，而非 POST 返回的 seq", async () => {
    stubApi({
      [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi"), runStarted(2)] }),
      [`GET ${BASE}`]: () => json(200, { conversation: { id: "c1" } }),
      [`POST ${BASE}/messages`]: () => json(202, { event: userMsg(9, "later") }),
    });
    renderChat("en");
    await screen.findAllByRole("button", { name: en.chat.stop });
    const es = FakeEventSource.instances[0] as FakeEventSource;
    act(() => es.emit("event", ev(3, "model_call", { step: 0, provider: "p", model: "m" })));
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(en.chat.inputLabel), "later");
    await user.click(screen.getByRole("button", { name: en.chat.send }));
    await screen.findByText("later");
    act(() => es.giveUp());
    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    expect(FakeEventSource.instances[1]?.url).toBe(`${BASE}/stream?after=3`);
  });

  it.each([
    ["reasoning 为 true：显示思考区", true, true],
    ["reasoning 为 false：不显示思考区", false, false],
    ["模型列表取不到：有思考内容就显示", undefined, true],
  ] as const)("思考区按模型的 capabilities.reasoning 显示（%s）", async (_, reasoning, shown) => {
    stubApi({
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
            ev(4, "run_finished", { reason: "completed", consumedUpToSeq: 3 }),
          ],
        }),
      ...(reasoning !== undefined && {
        "GET /api/v1/orgs/o1/models": () =>
          json(200, {
            providers: [
              {
                provider: "model-fake",
                models: [
                  {
                    id: "fake-1",
                    displayName: "Fake 1",
                    capabilities: { reasoning },
                    parameters: [],
                  },
                ],
              },
            ],
          }),
      }),
    });
    renderChat("en");
    await screen.findByText("answer");
    if (shown) {
      expect(await screen.findByText(en.chat.thinking)).toBeTruthy();
    } else {
      await vi.waitFor(() => expect(screen.queryByText(en.chat.thinking)).toBeNull());
    }
  });

  it("每次成功建立连接都清零重开计数：空闲会话多次断线不会显示「连接已断开」", async () => {
    stubApi({
      [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi")] }),
      [`GET ${BASE}`]: () => json(200, { conversation: { id: "c1" } }),
    });
    renderChat("en");
    await screen.findByText("hi");
    for (let i = 1; i <= 5; i++) {
      const es = FakeEventSource.instances[i - 1] as FakeEventSource;
      act(() => {
        es.emit("open");
        es.giveUp();
      });
      await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(i + 1));
    }
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("对话页切换组织", () => {
  function renderInFrame() {
    return render(
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
  }
  const twoOrgs = (currentOrgId: string) => ({
    ...ME,
    currentOrgId,
    memberships: [...ME.memberships, { orgId: "o2", slug: "b", name: "Beta", role: "member" }],
  });

  it("切到其他组织：跳回 /agents，且不以新组织 + 旧会话读取", async () => {
    let current = "o1";
    const calls = stubApi({
      "GET /api/v1/me": () => json(200, twoOrgs(current)),
      "PUT /api/v1/me/current-org": () => {
        current = "o2";
        return new Response(null, { status: 204 });
      },
      [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi")] }),
      [`GET ${BASE}`]: () => json(200, { conversation: { id: "c1" } }),
    });
    renderInFrame();
    await screen.findByText("hi");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Organization: Acme" }));
    await user.click(await screen.findByRole("menuitem", { name: "Beta" }));
    await vi.waitFor(() => expect(router.push).toHaveBeenCalledWith("/agents"));
    await vi.waitFor(() => expect(screen.getByRole("button", { name: /Beta/ })).toBeTruthy());
    // 顶栏的收件箱待处理数与「扩展」菜单按新组织读取是正常的；会话不能以新组织读取
    expect(
      calls.some(
        (c) =>
          c.url.includes("/orgs/o2/") &&
          !c.url.includes("/orgs/o2/inbox") &&
          !c.url.includes("/orgs/o2/ui/contributions"),
      ),
    ).toBe(false);
    expect(screen.queryByText("hi")).toBeNull();
  });

  it("切换后刷新会话失败：以 toast 提示错误", async () => {
    let meCalls = 0;
    stubApi({
      "GET /api/v1/me": () =>
        ++meCalls === 1
          ? json(200, twoOrgs("o1"))
          : json(500, { error: { code: "http_error", message: "boom" } }),
      "PUT /api/v1/me/current-org": () => new Response(null, { status: 204 }),
      [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi")] }),
      [`GET ${BASE}`]: () => json(200, { conversation: { id: "c1" } }),
    });
    renderInFrame();
    await screen.findByText("hi");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Organization: Acme" }));
    await user.click(await screen.findByRole("menuitem", { name: "Beta" }));
    expect(await screen.findByText(en.errors.http_error)).toBeTruthy();
  });
});

describe("输入框：/ 斜杠命令与 @ 资源引用（MCP prompts / resources）", () => {
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
      {
        connectorId: "a1",
        connectorSlug: "docs",
        connectorName: "Docs",
        name: "hello",
        arguments: [],
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

  it("空输入框键入 / → 面板列出 /连接器:提示名；有参数时弹对话框，渲染结果放进输入框", async () => {
    const calls = stubApi({
      [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi")] }),
      [`GET ${APPS}/prompts`]: () => json(200, PROMPTS),
      [`POST ${APPS}/a1/prompts/summarize`]: () => json(200, { text: "Summarize cats please" }),
      [`POST ${APPS}/a1/prompts/hello`]: () => json(200, { text: "Hello there" }),
    });
    renderChat("en");
    await screen.findByText("hi");
    const user = userEvent.setup();
    const input = screen.getByLabelText(en.chat.inputLabel);
    await user.type(input, "/");
    expect(input).toHaveProperty("value", "");
    const option = await screen.findByRole("option", {
      name: "/docs:summarize — Summarize a topic",
    });
    // 未连接的连接器单独一组
    expect(
      screen.getByRole("option", { name: `Mail · ${en.chat.connectorUnavailable.not_connected}` }),
    ).toBeTruthy();
    await user.click(option);
    const dialog = await screen.findByRole("dialog", { name: "/docs:summarize" });
    const insert = within(dialog).getByRole("button", { name: en.chat.insertPrompt });
    expect(insert).toHaveProperty("disabled", true);
    await user.type(within(dialog).getByLabelText(/topic/), "cats");
    await user.click(insert);
    await vi.waitFor(() =>
      expect(screen.getByLabelText(en.chat.inputLabel)).toHaveProperty(
        "value",
        "Summarize cats please",
      ),
    );
    const post = calls.find((c) => c.url === `${APPS}/a1/prompts/summarize`);
    expect(JSON.parse(String(post?.body))).toEqual({ arguments: { topic: "cats" } });

    // 无参数的提示：选中即渲染
    await user.clear(screen.getByLabelText(en.chat.inputLabel));
    await user.type(screen.getByLabelText(en.chat.inputLabel), "/");
    await user.click(await screen.findByRole("option", { name: "/docs:hello" }));
    await vi.waitFor(() =>
      expect(screen.getByLabelText(en.chat.inputLabel)).toHaveProperty("value", "Hello there"),
    );
  });

  it("不选任何条目就关闭面板：键入的 / 或 @ 留在输入框里（可以发以它们开头的普通消息）", async () => {
    stubApi({
      [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi")] }),
      [`GET ${APPS}/prompts`]: () => json(200, PROMPTS),
      [`GET ${APPS}/resources`]: () => json(200, RESOURCES),
    });
    renderChat("en");
    await screen.findByText("hi");
    const user = userEvent.setup();
    const input = screen.getByLabelText(en.chat.inputLabel);
    await user.type(input, "/");
    await screen.findByRole("option", { name: "/docs:hello" });
    await user.keyboard("{Escape}");
    await vi.waitFor(() => expect(screen.queryByRole("option")).toBeNull());
    expect(input).toHaveProperty("value", "/");
    await user.type(input, "path");
    expect(input).toHaveProperty("value", "/path");

    await user.clear(input);
    await user.type(input, "mail @");
    await screen.findByRole("option", { name: "Handbook · docs://handbook" });
    await user.keyboard("{Escape}");
    await vi.waitFor(() => expect(screen.queryByRole("option")).toBeNull());
    expect(input).toHaveProperty("value", "mail @");
  });

  it("键入 @ → 面板列出资源；选中后作为附件随消息发送，可移除；消息里显示附件", async () => {
    const calls = stubApi({
      [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi")] }),
      [`GET ${APPS}/resources`]: () => json(200, RESOURCES),
      [`POST ${BASE}/messages`]: (c) => {
        const body = JSON.parse(String(c.body)) as { text: string };
        return json(202, {
          event: ev(
            2,
            "user_message",
            {
              content: [
                { type: "text", text: body.text },
                { type: "text", text: "Attached resource …" },
              ],
              attachments: [
                { appId: "a1", appName: "Docs", uri: "docs://handbook", name: "Handbook" },
              ],
              authorAccountId: "a1",
            },
            null,
          ),
        });
      },
    });
    renderChat("zh");
    await screen.findByText("hi");
    const user = userEvent.setup();
    const input = screen.getByLabelText(zh.chat.inputLabel);
    await user.type(input, "read @");
    expect(input).toHaveProperty("value", "read ");
    await user.click(await screen.findByRole("option", { name: "Handbook · docs://handbook" }));
    const group = await screen.findByRole("group", { name: zh.chat.attachments });
    expect(within(group).getByText("@Handbook")).toBeTruthy();

    // 移除再加回
    await user.click(within(group).getByRole("button", { name: "移除 Handbook" }));
    expect(screen.queryByRole("group", { name: zh.chat.attachments })).toBeNull();
    await user.type(screen.getByLabelText(zh.chat.inputLabel), " @");
    await user.click(await screen.findByRole("option", { name: "Handbook · docs://handbook" }));

    await user.click(screen.getByRole("button", { name: zh.chat.send }));
    const post = calls.find((c) => c.method === "POST" && c.url === `${BASE}/messages`);
    expect(JSON.parse(String(post?.body))).toMatchObject({
      text: "read",
      attachments: [{ connectorId: "a1", uri: "docs://handbook" }],
    });
    // 发送成功：输入框的附件清空；消息里只显示用户文本与附件条目
    expect(await screen.findByText("@Handbook · Docs")).toBeTruthy();
    expect(screen.queryByText("Attached resource …")).toBeNull();
    expect(screen.queryByText("@Handbook")).toBeNull();
  });
});
