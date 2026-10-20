import { describe, expect, it, vi } from "vitest";
import {
  createEmbedBridge,
  EMBED_PROTOCOL,
  type EmbedBridgeOptions,
  type EmbedParentMessage,
  parseEmbedChildMessage,
  readDesignTokens,
} from "../src/lib/embed-bridge";

/**
 * 外层页面与嵌入 iframe 的消息桥（审查重点 4）：只认这个 iframe 发来的、协议正确的消息；
 * navigate 只放行站内路径；令牌在过期前 60 秒续期并发 `token`；主题切换发 `theme`。
 */

/** 可控的假计时器（注入给消息桥）。 */
function fakeClock(start = 1_000_000) {
  let now = start;
  let seq = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    timers: {
      setTimeout(fn: () => void, ms: number) {
        const id = ++seq;
        pending.set(id, { at: now + ms, fn });
        return id;
      },
      clearTimeout(id: unknown) {
        pending.delete(id as number);
      },
    },
    /** 往前走 ms，按时间顺序触发到期的计时器。 */
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const next = [...pending.entries()]
          .filter(([, t]) => t.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        pending.delete(next[0]);
        now = next[1].at;
        next[1].fn();
        // 让续期的 Promise 链跑完
        for (let i = 0; i < 10; i++) await Promise.resolve();
      }
      now = end;
    },
    pending: () => [...pending.values()].map((t) => t.at),
  };
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function setup(over: Partial<EmbedBridgeOptions> = {}) {
  const clock = fakeClock();
  const frame = { name: "iframe window" };
  const posted: EmbedParentMessage[] = [];
  let n = 0;
  const fetchToken = vi.fn(async () => {
    n += 1;
    return { token: `tok-${n}`, expiresAt: new Date(clock.now() + 300_000).toISOString() };
  });
  const opts: EmbedBridgeOptions = {
    post: (m) => posted.push(m),
    frameWindow: () => frame,
    fetchToken,
    locale: "zh",
    context: { orgId: "o1", conversationId: "c1" },
    readTheme: () => ({ theme: "dark", tokens: { "--cb-bg": "black" } }),
    onResize: vi.fn(),
    onNavigate: vi.fn(),
    onToast: vi.fn(),
    onTokenError: vi.fn(),
    timers: clock.timers,
    now: clock.now,
    ...over,
  };
  const bridge = createEmbedBridge(opts);
  return { bridge, clock, frame, posted, opts, fetchToken };
}

const child = (m: Record<string, unknown>) => ({ protocol: EMBED_PROTOCOL, ...m });

describe("parseEmbedChildMessage（与 SDK 同一规则）", () => {
  it("navigate 只认单个 / 开头的站内路径", () => {
    for (const bad of [
      "https://x",
      "//x",
      "/\\x",
      "javascript:alert(1)",
      "x",
      "",
      "/a\nb",
      "/a\tb",
      `/${"a".repeat(2001)}`,
    ]) {
      expect(parseEmbedChildMessage(child({ type: "navigate", path: bad })), bad).toBeNull();
    }
    expect(parseEmbedChildMessage(child({ type: "navigate", path: "/chat/c2" }))).toEqual({
      protocol: EMBED_PROTOCOL,
      type: "navigate",
      path: "/chat/c2",
    });
  });

  it("协议、类型、字段不对 → null", () => {
    expect(parseEmbedChildMessage({ type: "resize", height: 10 })).toBeNull();
    expect(
      parseEmbedChildMessage({ protocol: "capybara-embed/2", type: "resize", height: 10 }),
    ).toBe(null);
    expect(parseEmbedChildMessage(child({ type: "resize", height: -1 }))).toBeNull();
    expect(parseEmbedChildMessage(child({ type: "resize", height: 10_001 }))).toBeNull();
    expect(parseEmbedChildMessage(child({ type: "resize", height: Number.NaN }))).toBeNull();
    expect(parseEmbedChildMessage(child({ type: "toast", text: "" }))).toBeNull();
    expect(parseEmbedChildMessage(child({ type: "eval", code: "x" }))).toBeNull();
    expect(parseEmbedChildMessage("string")).toBeNull();
    expect(parseEmbedChildMessage(null)).toBeNull();
  });
});

describe("createEmbedBridge", () => {
  it("iframe 加载后发 init（令牌、语言、主题、设计 token、上下文）", async () => {
    const { bridge, posted } = setup();
    await bridge.start();
    expect(posted).toEqual([]);
    bridge.loaded();
    expect(posted).toEqual([
      {
        protocol: EMBED_PROTOCOL,
        type: "init",
        token: "tok-1",
        locale: "zh",
        theme: "dark",
        tokens: { "--cb-bg": "black" },
        context: { orgId: "o1", conversationId: "c1" },
      },
    ]);
  });

  it("iframe 先加载、令牌后到：令牌到了再发 init", async () => {
    const { bridge, posted } = setup();
    bridge.loaded();
    expect(posted).toEqual([]);
    await bridge.start();
    expect(posted.map((m) => m.type)).toEqual(["init"]);
  });

  it("忽略其他 window 发来的消息", async () => {
    const { bridge, opts } = setup();
    await bridge.start();
    bridge.receive({ source: { other: true }, data: child({ type: "toast", text: "hi" }) });
    bridge.receive({ source: null, data: child({ type: "navigate", path: "/x" }) });
    expect(opts.onToast).not.toHaveBeenCalled();
    expect(opts.onNavigate).not.toHaveBeenCalled();
  });

  it("忽略协议不符 / 未知类型的消息", async () => {
    const { bridge, frame, opts } = setup();
    await bridge.start();
    bridge.receive({ source: frame, data: { type: "toast", text: "no protocol" } });
    bridge.receive({ source: frame, data: { protocol: "other/1", type: "toast", text: "x" } });
    bridge.receive({ source: frame, data: child({ type: "unknown" }) });
    bridge.receive({ source: frame, data: "capybara-embed/1" });
    expect(opts.onToast).not.toHaveBeenCalled();
    expect(opts.onResize).not.toHaveBeenCalled();
  });

  it("navigate：站内路径交给路由；https://x 与 //x 拒绝", async () => {
    const { bridge, frame, opts } = setup();
    await bridge.start();
    for (const path of ["https://x", "//x", "/\\x", "javascript:alert(1)"]) {
      bridge.receive({ source: frame, data: child({ type: "navigate", path }) });
    }
    expect(opts.onNavigate).not.toHaveBeenCalled();
    bridge.receive({ source: frame, data: child({ type: "navigate", path: "/chat/c2" }) });
    expect(opts.onNavigate).toHaveBeenCalledWith("/chat/c2");
  });

  it("resize 夹在上下限之间；toast 交给提示", async () => {
    const { bridge, frame, opts } = setup();
    await bridge.start();
    bridge.receive({ source: frame, data: child({ type: "resize", height: 500 }) });
    bridge.receive({ source: frame, data: child({ type: "resize", height: 0 }) });
    bridge.receive({ source: frame, data: child({ type: "resize", height: 10_000 }) });
    expect(vi.mocked(opts.onResize).mock.calls.map((c) => c[0])).toEqual([500, 120, 4000]);
    bridge.receive({ source: frame, data: child({ type: "toast", text: "Saved" }) });
    expect(opts.onToast).toHaveBeenCalledWith("Saved");
  });

  it("续期在过期前 60 秒发出（假时钟），之后按新的过期时间继续", async () => {
    const { bridge, clock, posted, fetchToken } = setup();
    await bridge.start();
    bridge.loaded();
    expect(fetchToken).toHaveBeenCalledTimes(1);
    // 有效期 300 秒：240 秒时续期
    await clock.advance(239_999);
    expect(fetchToken).toHaveBeenCalledTimes(1);
    await clock.advance(1);
    await flush();
    expect(fetchToken).toHaveBeenCalledTimes(2);
    expect(posted.at(-1)).toEqual({ protocol: EMBED_PROTOCOL, type: "token", token: "tok-2" });
    await clock.advance(240_000);
    await flush();
    expect(fetchToken).toHaveBeenCalledTimes(3);
    expect(posted.at(-1)).toEqual({ protocol: EMBED_PROTOCOL, type: "token", token: "tok-3" });
  });

  it("续期失败：报告并在稍后重试；dispose 后不再续期", async () => {
    const { bridge, clock, opts, fetchToken } = setup();
    await bridge.start();
    fetchToken.mockRejectedValueOnce(new Error("offline"));
    await clock.advance(240_000);
    await flush();
    expect(opts.onTokenError).toHaveBeenCalledTimes(1);
    await clock.advance(10_000);
    await flush();
    expect(fetchToken).toHaveBeenCalledTimes(3);
    bridge.dispose();
    expect(clock.pending()).toEqual([]);
    await clock.advance(600_000);
    expect(fetchToken).toHaveBeenCalledTimes(3);
  });

  it("主题切换发 theme（含设计 token）", async () => {
    let theme: "dark" | "light" = "dark";
    const { bridge, posted } = setup({
      readTheme: () => ({ theme, tokens: { "--cb-bg": theme === "dark" ? "black" : "white" } }),
    });
    await bridge.start();
    bridge.loaded();
    theme = "light";
    bridge.themeChanged();
    expect(posted.at(-1)).toEqual({
      protocol: EMBED_PROTOCOL,
      type: "theme",
      theme: "light",
      tokens: { "--cb-bg": "white" },
    });
  });

  it("iframe 未加载前不发任何消息（续期、主题都不发）", async () => {
    const { bridge, clock, posted } = setup();
    await bridge.start();
    bridge.themeChanged();
    await clock.advance(240_000);
    await flush();
    expect(posted).toEqual([]);
  });
});

describe("readDesignTokens", () => {
  it("只取 --cb-* 自定义属性的名称与值", () => {
    const root = document.documentElement;
    root.style.setProperty("--cb-bg", " #000 ");
    root.style.setProperty("--cb-fg", "#fff");
    root.style.setProperty("--other", "x");
    const tokens = readDesignTokens(document);
    expect(tokens["--cb-bg"]).toBe("#000");
    expect(tokens["--cb-fg"]).toBe("#fff");
    expect(tokens["--other"]).toBeUndefined();
    root.removeAttribute("style");
  });
});
