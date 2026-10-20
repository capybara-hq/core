/**
 * 外层页面与嵌入 iframe 之间的 postMessage 消息桥（spec §5.3）。
 * 协议照抄 `packages/plugin-sdk/src/ui.ts`（`EMBED_PROTOCOL` / `EmbedParentMessage` / `EmbedChildMessage` /
 * `parseEmbedChildMessage`）：Web 层只依赖 design，不 import SDK，SDK 改了这里要同步。
 *
 * 只认这个 iframe 发来的（`event.source` 是它的 window）、协议与字段都对的消息，其余一律忽略：
 * - `resize`：高度夹在 {@link EMBED_MIN_HEIGHT}–{@link EMBED_MAX_HEIGHT} 之间；
 * - `navigate`：只放行站内路径（见 `isInSitePath`；交给站内路由，不经 `location`）；
 * - `toast`：显示一条提示（纯文本）。
 * 发给 iframe：第一次加载后 `init`，令牌过期前 60 秒续期并发 `token`，主题切换发 `theme`。
 * 同一个 iframe 再次 `load` 说明嵌入页自己导航走了（可能已不是插件页面）：此后不再给它发任何消息，
 * 调用方在原 `src` 上重新挂载 iframe（插件的多页面应用请用 History API，不要整页跳转）。
 * 续期时间按本地收到令牌的时刻加上 `expiresIn` 计算，不受本机与服务端时钟偏差影响。
 * 沙箱 iframe 是不透明源，`postMessage` 的 targetOrigin 只能是 `*`；令牌只对这个插件有效、几分钟过期。
 */

export const EMBED_PROTOCOL = "capybara-embed/1";

export type EmbedTheme = "dark" | "light";

export type EmbedParentMessage =
  | {
      protocol: typeof EMBED_PROTOCOL;
      type: "init";
      token: string;
      locale: "zh" | "en";
      theme: EmbedTheme;
      tokens: Record<string, string>;
      context: { orgId: string; conversationId?: string };
    }
  | { protocol: typeof EMBED_PROTOCOL; type: "token"; token: string }
  | {
      protocol: typeof EMBED_PROTOCOL;
      type: "theme";
      theme: EmbedTheme;
      tokens: Record<string, string>;
    };

export type EmbedChildMessage =
  | { protocol: typeof EMBED_PROTOCOL; type: "resize"; height: number }
  | { protocol: typeof EMBED_PROTOCOL; type: "navigate"; path: string }
  | { protocol: typeof EMBED_PROTOCOL; type: "toast"; text: string };

/** 令牌过期前多久续期（毫秒）。 */
export const EMBED_REFRESH_BEFORE_MS = 60_000;
/** 两次续期之间至少隔多久（毫秒）：有效期很短或异常时也不会连续请求。 */
export const EMBED_REFRESH_MIN_MS = 30_000;
/** 续期失败后多久重试（毫秒）。 */
export const EMBED_RETRY_MS = 10_000;
export const EMBED_MIN_HEIGHT = 120;
export const EMBED_MAX_HEIGHT = 4000;

const NAV_MAX = 2000;
const RESIZE_MAX = 10000;
const TOAST_MAX = 500;
// biome-ignore lint/suspicious/noControlCharactersInRegex: 正是要拒绝控制字符
const NAV_BAD = /[\u0000-\u001f\u007f\\]/;

/**
 * 站内路径：以单个 `/` 开头，任何位置都没有 `//`，没有控制字符与反斜杠，路径部分没有 `.` / `..` 段
 * （含任意大小写的 `%2e` 编码），且按 URL 规范化后与原文完全相同、不以 `//` 开头——
 * 规范化不会把它变成别的路径，交给站内路由时不会跳到站外或上层目录。
 */
function isInSitePath(p: string): boolean {
  if (!p.startsWith("/") || p.includes("//") || NAV_BAD.test(p)) return false;
  const path = p.split(/[?#]/, 1)[0] ?? "";
  for (const seg of path.split("/")) {
    const s = seg.toLowerCase().replaceAll("%2e", ".");
    if (s === "." || s === "..") return false;
  }
  let u: URL;
  try {
    u = new URL(p, "http://x");
  } catch {
    return false;
  }
  return u.pathname + u.search + u.hash === p && !u.pathname.startsWith("//");
}
/** 设计 token 的数量与单值长度上限（只发名称与值，不发页面内容）。 */
const TOKENS_MAX = 300;
const TOKEN_VALUE_MAX = 200;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** 解析 iframe 发来的消息（与 SDK 同一规则）：协议、类型、字段都对才返回只含已知字段的新对象，否则 null。 */
export function parseEmbedChildMessage(m: unknown): EmbedChildMessage | null {
  if (!isObj(m) || m.protocol !== EMBED_PROTOCOL) return null;
  const protocol = EMBED_PROTOCOL;
  switch (m.type) {
    case "resize":
      return typeof m.height === "number" &&
        Number.isFinite(m.height) &&
        m.height >= 0 &&
        m.height <= RESIZE_MAX
        ? { protocol, type: "resize", height: m.height }
        : null;
    case "navigate": {
      const p = m.path;
      if (typeof p !== "string" || p.length > NAV_MAX) return null;
      if (!isInSitePath(p)) return null;
      return { protocol, type: "navigate", path: p };
    }
    case "toast":
      return typeof m.text === "string" && m.text !== "" && m.text.length <= TOAST_MAX
        ? { protocol, type: "toast", text: m.text }
        : null;
    default:
      return null;
  }
}

/**
 * 读当前文档的设计 token（`--cb-*` 自定义属性的计算值）。名称从样式表里的声明与根元素的计算样式收集
 * （跨源样式表读不到规则，跳过）。
 */
export function readDesignTokens(doc: Document): Record<string, string> {
  const names = new Set<string>();
  const collect = (style: CSSStyleDeclaration) => {
    for (let i = 0; i < style.length && names.size < TOKENS_MAX; i++) {
      const n = style.item(i);
      if (n.startsWith("--cb-")) names.add(n);
    }
  };
  const walk = (rules: CSSRuleList) => {
    for (const r of Array.from(rules)) {
      if ("style" in r && r.style instanceof CSSStyleDeclaration) collect(r.style);
      if ("cssRules" in r && r.cssRules instanceof CSSRuleList) walk(r.cssRules);
    }
  };
  for (const sheet of Array.from(doc.styleSheets)) {
    try {
      walk(sheet.cssRules);
    } catch {
      // 跨源样式表
    }
  }
  const view = doc.defaultView;
  const computed = view?.getComputedStyle(doc.documentElement);
  if (computed) collect(computed);
  collect(doc.documentElement.style);
  const out: Record<string, string> = {};
  for (const n of names) {
    const v = (
      computed?.getPropertyValue(n) || doc.documentElement.style.getPropertyValue(n)
    ).trim();
    if (v !== "" && v.length <= TOKEN_VALUE_MAX) out[n] = v;
  }
  return out;
}

/** 当前主题（`<html data-theme>`，非法值按深色）。 */
export function readTheme(doc: Document): EmbedTheme {
  return doc.documentElement.dataset.theme === "light" ? "light" : "dark";
}

export interface EmbedTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface EmbedBridgeOptions {
  /** 发给 iframe（调用方用 `contentWindow.postMessage(msg, "*")`）。 */
  post(msg: EmbedParentMessage): void;
  /** iframe 的 window：只认 `event.source` 是它的消息。 */
  frameWindow(): unknown;
  /** 取一个新令牌（内核 `POST .../ui/embeds/:plugin/:id/token`）；`expiresIn` 为有效期秒数。 */
  fetchToken(): Promise<{ token: string; expiresIn: number }>;
  locale: "zh" | "en";
  context: { orgId: string; conversationId?: string };
  readTheme(): { theme: EmbedTheme; tokens: Record<string, string> };
  onResize(height: number): void;
  onNavigate(path: string): void;
  onToast(text: string): void;
  /** 续期失败（会在 {@link EMBED_RETRY_MS} 后重试）。 */
  onTokenError?(e: unknown): void;
  /** iframe 再次 load（嵌入页导航走了）：调用方在原 src 上重新挂载 iframe，挂好后调 `frameReset()`。 */
  onNavigatedAway?(): void;
  /** 可注入的计时器（测试用假时钟）。 */
  timers?: EmbedTimers;
}

export interface EmbedBridge {
  /** 取第一个令牌并安排续期；失败时抛出（调用方显示错误、可重试）。 */
  start(): Promise<void>;
  /**
   * iframe 加载完成。同一个 iframe 只在第一次 load 发 `init`（令牌还没到就等令牌到了再发）；
   * 再次 load 说明它导航走了：停止给它发消息并调 `onNavigatedAway`。
   */
  loaded(): void;
  /** 调用方换上了新的 iframe（同一个 src）：回到「等第一次 load」。 */
  frameReset(): void;
  /** 收到 window 的 message 事件。 */
  receive(e: { source: unknown; data: unknown }): void;
  /** 外层主题变了：发 `theme`。 */
  themeChanged(): void;
  /** 卸载：停止续期，此后什么都不发。 */
  dispose(): void;
}

const defaultTimers: EmbedTimers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
};

export function createEmbedBridge(o: EmbedBridgeOptions): EmbedBridge {
  const timers = o.timers ?? defaultTimers;
  let token: string | undefined;
  let isLoaded = false;
  /** 当前 iframe 已导航离开插件页面：不再给它发任何消息。 */
  let away = false;
  let disposed = false;
  let timer: unknown;

  const post = (msg: EmbedParentMessage) => {
    if (!disposed && isLoaded && !away) o.post(msg);
  };
  const sendInit = () => {
    if (token === undefined) return;
    const { theme, tokens } = o.readTheme();
    post({
      protocol: EMBED_PROTOCOL,
      type: "init",
      token,
      locale: o.locale,
      theme,
      tokens,
      context: {
        orgId: o.context.orgId,
        ...(o.context.conversationId !== undefined && {
          conversationId: o.context.conversationId,
        }),
      },
    });
  };
  const schedule = (ms: number) => {
    if (disposed) return;
    if (timer !== undefined) timers.clearTimeout(timer);
    timer = timers.setTimeout(
      () => {
        timer = undefined;
        void refresh();
      },
      Math.max(0, ms),
    );
  };
  const accept = (t: { token: string; expiresIn: number }): boolean => {
    if (disposed) return false;
    token = t.token;
    // 从此刻（本地收到令牌）起算，不比较本机时钟与服务端的过期时间
    const lifeMs = Number.isFinite(t.expiresIn) ? t.expiresIn * 1000 : 0;
    schedule(Math.max(EMBED_REFRESH_MIN_MS, lifeMs - EMBED_REFRESH_BEFORE_MS));
    return true;
  };
  const refresh = async () => {
    try {
      const t = await o.fetchToken();
      if (accept(t)) post({ protocol: EMBED_PROTOCOL, type: "token", token: t.token });
    } catch (e) {
      if (disposed) return;
      o.onTokenError?.(e);
      schedule(EMBED_RETRY_MS);
    }
  };

  return {
    async start() {
      const t = await o.fetchToken();
      if (accept(t)) sendInit();
    },
    loaded() {
      if (disposed || away) return;
      if (isLoaded) {
        away = true;
        o.onNavigatedAway?.();
        return;
      }
      isLoaded = true;
      sendInit();
    },
    frameReset() {
      isLoaded = false;
      away = false;
    },
    receive(e) {
      if (disposed || away) return;
      const win = o.frameWindow();
      if (win === null || win === undefined || e.source !== win) return;
      const m = parseEmbedChildMessage(e.data);
      if (m === null) return;
      if (m.type === "resize")
        o.onResize(Math.min(EMBED_MAX_HEIGHT, Math.max(EMBED_MIN_HEIGHT, Math.round(m.height))));
      else if (m.type === "navigate") o.onNavigate(m.path);
      else o.onToast(m.text);
    },
    themeChanged() {
      const { theme, tokens } = o.readTheme();
      post({ protocol: EMBED_PROTOCOL, type: "theme", theme, tokens });
    },
    dispose() {
      disposed = true;
      if (timer !== undefined) timers.clearTimeout(timer);
      timer = undefined;
    },
  };
}
