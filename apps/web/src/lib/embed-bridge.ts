/**
 * The postMessage bridge between the host page and an embed iframe (spec §5.3).
 * The protocol copies `packages/plugin-sdk/src/ui.ts` (`EMBED_PROTOCOL` / `EmbedParentMessage` /
 * `EmbedChildMessage` / `parseEmbedChildMessage`): the web depends only on design and never imports
 * the SDK, so a change there must be mirrored here.
 *
 * Only messages from this iframe (`event.source` is its window) with the right protocol and fields
 * are accepted; everything else is ignored:
 * - `resize`: the height is clamped to {@link EMBED_MIN_HEIGHT}–{@link EMBED_MAX_HEIGHT};
 * - `navigate`: only in-site paths pass (see `isInSitePath`; handed to the app router, never `location`);
 * - `toast`: shows one notice (plain text);
 * - `panel-mode`: asks the right panel to enter or leave full mode (`full` must be a boolean); it takes
 *   effect only when the caller passes `onPanelMode` (embeds mounted in the `conversation.panel`
 *   slot), and is ignored from embeds in every other slot.
 * Sent to the iframe: `init` after the first load, `token` 60 s before the token expires, `theme` on
 * a theme change, and to a `conversation.panel` embed (the caller passes `panelFull`) `panel-mode`
 * with the panel's mode right after `init` and on every change, whoever changed it.
 * A second `load` of the same iframe means the embed navigated away on its own (it may no longer be
 * the plugin's page): no further messages are sent to it, and the caller remounts the iframe on the
 * original `src` (multi-page plugin apps use the History API, not full page loads).
 * Renewal is timed from the local moment the token arrived plus `expiresIn`, so clock skew between
 * this machine and the server does not matter.
 * A sandboxed iframe has an opaque origin, so the postMessage targetOrigin can only be `*`; the token
 * is valid only for this plugin and expires within minutes.
 */

export const EMBED_PROTOCOL = "capybara-embed/1";

/**
 * Where an embed is shown (SDK `EmbedInitContext`, narrowed on `scope`): an org's page, a platform
 * page (no org), or a share page (no org, no conversation).
 */
export type EmbedInitContext =
  | { scope: "org"; orgId: string; conversationId?: string }
  | { scope: "platform" }
  | { scope: "share" };

export type EmbedTheme = "dark" | "light";

export type EmbedParentMessage =
  | {
      protocol: typeof EMBED_PROTOCOL;
      type: "init";
      token: string;
      locale: "zh" | "en";
      theme: EmbedTheme;
      tokens: Record<string, string>;
      context: EmbedInitContext;
    }
  | { protocol: typeof EMBED_PROTOCOL; type: "token"; token: string }
  | {
      protocol: typeof EMBED_PROTOCOL;
      type: "theme";
      theme: EmbedTheme;
      tokens: Record<string, string>;
    }
  /**
   * Only to an embed in the `conversation.panel` slot: whether the right panel is maximised, right
   * after `init` and on every change (the embed's own ask, the host's close control, Esc, a size
   * class change).
   */
  | { protocol: typeof EMBED_PROTOCOL; type: "panel-mode"; full: boolean }
  /** Only to a `file-preview` embed, once after `init`: the file it previews (never a URL). */
  | {
      protocol: typeof EMBED_PROTOCOL;
      type: "file";
      name: string;
      contentType: string;
      size: number;
      data: ArrayBuffer;
    };

/** The file a `file-preview` embed previews (the caller reads it through the kernel). */
export interface EmbedFile {
  name: string;
  contentType: string;
  size: number;
  data: ArrayBuffer;
}

export type EmbedChildMessage =
  | { protocol: typeof EMBED_PROTOCOL; type: "resize"; height: number }
  | { protocol: typeof EMBED_PROTOCOL; type: "navigate"; path: string }
  | { protocol: typeof EMBED_PROTOCOL; type: "toast"; text: string }
  | { protocol: typeof EMBED_PROTOCOL; type: "panel-mode"; full: boolean };

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
// capybara:embed-nav-begin (this section is verbatim identical in packages/plugin-sdk/src/ui.ts and apps/web/src/lib/embed-bridge.ts, checked by a test)
// Control characters and backslash: browsers treat `/\host` as `//host`, and strip newlines / tabs
// inside a path
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what must be rejected
const NAV_BAD = /[\u0000-\u001f\u007f\\]/;
/**
 * Encoded `/`, `\` and control characters in the path part (any case): decoding them would change
 * the path structure.
 */
const NAV_BAD_ENCODED = /%(?:2f|5c|[01][0-9a-f]|7f)/i;

/**
 * In-site path: starts with a single `/`, has no `//` anywhere, no control characters or
 * backslashes; the path part has no `.` / `..` segments
 * (including `%2e` in any case), no encoded `/` (`%2f`), `\` (`%5c`) or control characters
 * (`%00`–`%1f`, `%7f`);
 * and after URL normalization it is exactly identical to the original and does not start with `//`:
 * normalization cannot turn it into another path,
 * so handing it to in-site routing cannot jump outside the site or to a parent directory.
 */
function isInSitePath(p: string): boolean {
  if (!p.startsWith("/") || p.includes("//") || NAV_BAD.test(p)) return false;
  const path = p.split(/[?#]/, 1)[0] ?? "";
  if (NAV_BAD_ENCODED.test(path)) return false;
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
// capybara:embed-nav-end
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
    case "panel-mode":
      return typeof m.full === "boolean" ? { protocol, type: "panel-mode", full: m.full } : null;
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
  context: EmbedInitContext;
  readTheme(): { theme: EmbedTheme; tokens: Record<string, string> };
  onResize(height: number): void;
  onNavigate(path: string): void;
  onToast(text: string): void;
  /**
   * Only for an embed mounted in the `conversation.panel` slot: asks the host to maximise (`true`)
   * or restore (`false`) the right panel. Without it the message is ignored (the slot is the
   * caller's fact, never the message's).
   */
  onPanelMode?(full: boolean): void;
  /**
   * Only for an embed mounted in the `conversation.panel` slot: whether the right panel is
   * maximised now. Sent as `panel-mode` after `init`, and again by `panelModeChanged` when it
   * changes.
   */
  panelFull?(): boolean;
  /** 续期失败（会在 {@link EMBED_RETRY_MS} 后重试）。 */
  onTokenError?(e: unknown): void;
  /** iframe 再次 load（嵌入页导航走了）：调用方在原 src 上重新挂载 iframe，挂好后调 `frameReset()`。 */
  onNavigatedAway?(): void;
  /**
   * Only for a `file-preview` embed: reads the file to send once after `init` (other embeds never
   * get a `file` message).
   */
  file?(): Promise<EmbedFile>;
  /**
   * The previewer's `maxBytes` (from the previewers list): a file with more bytes is reported
   * through `onFileError` and never posted.
   */
  fileMaxBytes?: number;
  /** Reading the file for a `file-preview` embed failed (nothing is posted). */
  onFileError?(e: unknown): void;
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
  /**
   * The right panel's mode may have changed: sends `panel-mode` when it differs from what this
   * document was last told (only with `panelFull`; nothing before `init`).
   */
  panelModeChanged(): void;
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
  let fileSent = false;
  /** Bumped per document (frameReset): a read started for an earlier document is never posted. */
  let generation = 0;
  /** The panel mode this document was last told (undefined: not yet, or not a panel embed). */
  let toldFull: boolean | undefined;

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
      context: o.context,
    });
    toldFull = undefined;
    sendPanelMode();
    sendFile();
  };
  const sendPanelMode = () => {
    if (o.panelFull === undefined || disposed || !isLoaded || away || token === undefined) return;
    const full = o.panelFull();
    if (full === toldFull) return;
    toldFull = full;
    post({ protocol: EMBED_PROTOCOL, type: "panel-mode", full });
  };
  const sendFile = () => {
    if (o.file === undefined || fileSent || disposed || !isLoaded || away) return;
    fileSent = true;
    const gen = generation;
    o.file().then(
      (f) => {
        if (gen !== generation || disposed) return;
        if (o.fileMaxBytes !== undefined && f.data.byteLength > o.fileMaxBytes) {
          o.onFileError?.(
            new Error(`the file is larger than this previewer's maxBytes (${o.fileMaxBytes})`),
          );
          return;
        }
        post({
          protocol: EMBED_PROTOCOL,
          type: "file",
          name: f.name,
          contentType: f.contentType,
          size: f.size,
          data: f.data,
        });
      },
      (e) => {
        if (gen === generation && !disposed) o.onFileError?.(e);
      },
    );
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
      // a new document: it gets the file again after its init, never an earlier read's
      fileSent = false;
      generation += 1;
      toldFull = undefined;
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
      else if (m.type === "toast") o.onToast(m.text);
      else o.onPanelMode?.(m.full);
    },
    themeChanged() {
      const { theme, tokens } = o.readTheme();
      post({ protocol: EMBED_PROTOCOL, type: "theme", theme, tokens });
    },
    panelModeChanged() {
      // before init the document is told with its init
      if (toldFull !== undefined) sendPanelMode();
    },
    dispose() {
      disposed = true;
      if (timer !== undefined) timers.clearTimeout(timer);
      timer = undefined;
    },
  };
}
