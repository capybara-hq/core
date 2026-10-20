import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
 * 仓库根目录下的文件（jsdom 环境里 `import.meta.url` 不是 file: 地址；vitest 在仓库根运行）。
 */
const repoFile = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8");

/** navigate 路径的共享测试向量（与 packages/plugin-sdk/test/ui.test.ts 共用）。 */
const NAV_VECTORS = JSON.parse(repoFile("tools/fixtures/embed-navigate-vectors.json")) as {
  accept: string[];
  reject: string[];
};

/** 两份 `isInSitePath`（SDK 与网页的照抄）在标记之间的源码。 */
const navBlock = (rel: string): string => {
  const src = repoFile(rel);
  const m = /\/\/ capybara:embed-nav-begin[^\n]*\n([\s\S]*?)\/\/ capybara:embed-nav-end/.exec(src);
  if (!m) throw new Error(`embed-nav markers not found in ${rel}`);
  return m[1] as string;
};

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
    return { token: `tok-${n}`, expiresIn: 300 };
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
    onNavigatedAway: vi.fn(),
    timers: clock.timers,
    ...over,
  };
  const bridge = createEmbedBridge(opts);
  return { bridge, clock, frame, posted, opts, fetchToken };
}

const child = (m: Record<string, unknown>) => ({ protocol: EMBED_PROTOCOL, ...m });

describe("parseEmbedChildMessage（与 SDK 同一规则）", () => {
  it("navigate：共享向量里的 accept 原样放行、reject 一律拒绝；超长路径拒绝", () => {
    for (const path of NAV_VECTORS.accept) {
      expect(parseEmbedChildMessage(child({ type: "navigate", path })), path).toEqual({
        protocol: EMBED_PROTOCOL,
        type: "navigate",
        path,
      });
    }
    for (const bad of [...NAV_VECTORS.reject, `/${"a".repeat(2001)}`]) {
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

describe("createEmbedBridge：续期时钟与 iframe 导航（修复第 1 轮）", () => {
  it("续期按本地收到令牌的时刻 + expiresIn 计算，不看本机时钟与服务端 expiresAt 的差（时钟偏差）", async () => {
    // 本机时钟比服务端慢 1 小时：若按 expiresAt - Date.now() 算，会等 1 小时才续期（令牌早已过期）
    const clock = fakeClock();
    const fetchToken = vi.fn(async () => ({
      token: "t",
      expiresIn: 300,
      expiresAt: new Date(clock.now() + 3_600_000 + 300_000).toISOString(),
    }));
    const { bridge } = setup({ fetchToken, timers: clock.timers });
    await bridge.start();
    await clock.advance(240_000);
    await flush();
    expect(fetchToken).toHaveBeenCalledTimes(2);
  });

  it("本机时钟比服务端快：同样在收到后 240 秒续期，不会立刻续期", async () => {
    const clock = fakeClock();
    const fetchToken = vi.fn(async () => ({
      token: "t",
      expiresIn: 300,
      expiresAt: new Date(clock.now() - 3_600_000).toISOString(),
    }));
    const { bridge } = setup({ fetchToken, timers: clock.timers });
    await bridge.start();
    await clock.advance(239_000);
    await flush();
    expect(fetchToken).toHaveBeenCalledTimes(1);
    await clock.advance(1_000);
    await flush();
    expect(fetchToken).toHaveBeenCalledTimes(2);
  });

  it("续期间隔至少 30 秒（有效期很短或异常时也不会连续请求）", async () => {
    const clock = fakeClock();
    for (const expiresIn of [0, 10, 60, -5, Number.NaN]) {
      const fetchToken = vi.fn(async () => ({ token: "t", expiresIn }));
      const { bridge } = setup({ fetchToken, timers: clock.timers });
      await bridge.start();
      await clock.advance(29_999);
      await flush();
      expect(fetchToken, String(expiresIn)).toHaveBeenCalledTimes(1);
      await clock.advance(1);
      await flush();
      expect(fetchToken, String(expiresIn)).toHaveBeenCalledTimes(2);
      bridge.dispose();
    }
  });

  it("每个 src 只在第一次 load 发 init；之后再 load 说明 iframe 导航走了：不再发 token / theme，通知重新挂载", async () => {
    const { bridge, clock, posted, opts } = setup();
    await bridge.start();
    bridge.loaded();
    expect(posted.map((m) => m.type)).toEqual(["init"]);
    bridge.loaded();
    expect(posted.map((m) => m.type)).toEqual(["init"]);
    expect(opts.onNavigatedAway).toHaveBeenCalledTimes(1);
    bridge.themeChanged();
    await clock.advance(240_000);
    await flush();
    expect(posted.map((m) => m.type)).toEqual(["init"]);
  });
});

describe("isInSitePath 两份照抄保持一致", () => {
  it("SDK 与网页里 capybara:embed-nav-begin / end 之间的源码逐字相同", () => {
    const sdk = navBlock("packages/plugin-sdk/src/ui.ts");
    const web = navBlock("apps/web/src/lib/embed-bridge.ts");
    expect(sdk).toContain("function isInSitePath");
    expect(web).toBe(sdk);
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
