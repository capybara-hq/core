import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { ChatView } from "../src/components/ChatView";

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
  render(
    <NextIntlClientProvider locale={locale} messages={locale === "zh" ? zh : en}>
      <ChatView orgId="o1" conversationId="c1" />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  FakeEventSource.instances = [];
});

describe("ChatView", () => {
  it.each(["zh", "en"] as const)(
    "运行中显示「停止」按钮，点击调用 abort；输入框不禁用（%s）",
    async (locale) => {
      const m = locale === "zh" ? zh : en;
      const calls = stubApi({
        [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi"), runStarted(2)] }),
        [`POST ${BASE}/abort`]: () => json(202, { runId: "r1" }),
      });
      renderChat(locale);
      const stop = await screen.findByRole("button", { name: m.chat.stop });
      // 历史加载完后从最后一条 seq 开始订阅
      expect(FakeEventSource.instances[0]?.url).toBe(`${BASE}/stream?after=2`);
      expect(screen.getByLabelText(m.chat.inputLabel)).toHaveProperty("disabled", false);

      await userEvent.setup().click(stop);
      const abort = calls.find((c) => c.method === "POST" && c.url === `${BASE}/abort`);
      expect(abort?.headers.get("x-capybara-csrf")).toBe("1");

      // 运行结束后「停止」按钮消失
      act(() => {
        FakeEventSource.instances[0]?.emit(
          "event",
          ev(3, "run_aborted", { byAccountId: "a1", reason: "user" }),
        );
      });
      expect(screen.queryByRole("button", { name: m.chat.stop })).toBeNull();
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
      const message = (await screen.findByText("partial answer")).closest("li");
      expect(message).not.toBeNull();
      expect(within(message as HTMLElement).getByText(m.chat.stopped)).toBeTruthy();
      expect(screen.queryByRole("button", { name: m.chat.stop })).toBeNull();
    },
  );

  it("流式增量逐步显示，assistant_message 到达后替换草稿", async () => {
    stubApi({
      [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "hi"), runStarted(2)] }),
    });
    renderChat("en");
    await screen.findByRole("button", { name: en.chat.stop });
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
    await screen.findByRole("button", { name: en.chat.stop });
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
    expect((await screen.findByRole("alert")).textContent).toBe(zh.errors.auth.session_revoked);
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
    await screen.findByRole("button", { name: en.chat.stop });
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
