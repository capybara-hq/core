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
  emit(type: string, data: unknown) {
    const e = new MessageEvent(type, { data: JSON.stringify(data) });
    for (const fn of this.listeners.get(type) ?? []) fn(e);
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
});
