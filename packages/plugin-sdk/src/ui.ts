import type { Locale } from "./cards.js";
import { type FormAnswer, type InputForm, validateInputForm } from "./tool.js";
import { isHttpUrl } from "./url.js";

/**
 * Where a ui contribution goes (UI refresh spec §5.3):
 * - `panel`: a right panel of the conversation page, opened from the extension's icon in the title
 *   bar (one at a time);
 * - `section`: a section of the conversation's properties panel;
 * - `inline`: an inline card in the conversation, hanging off a tool result (`ToolResult.card`);
 * - `page`: an org page under "Extensions";
 * - `file-preview`: an embed previewer of `file-preview@1` (embed only, see `FilePreviewer.embed`);
 * - `conversation`: the old right-side tab; it means `panel` (see {@link normalizePlace}).
 */
export type UiPlace = "conversation" | "panel" | "section" | "inline" | "page" | "file-preview";

/** A place with the old `conversation` mapped to `panel`. */
export function normalizePlace(place: UiPlace): Exclude<UiPlace, "conversation"> {
  return place === "conversation" ? "panel" : place;
}

/**
 * Icons a contribution may use (design system icon names; `puzzle` is the default and is drawn as
 * the design `extension` icon). The title-bar button of a panel shows it.
 */
export const UI_ICONS = [
  "list-checks",
  "layout-grid",
  "file",
  "chart",
  "calendar",
  "users",
  "bot",
  "book",
  "message-square",
  "puzzle",
] as const;

export type UiIcon = (typeof UI_ICONS)[number];

/**
 * An "open" target: a `panel` contribution of the same extension, scrolled to the block or item
 * whose `id` equals `item` (the panel's render receives it as {@link UiRenderArgs.item}).
 */
export interface UiOpen {
  contribution: string;
  item?: string;
}

/** 界面贡献的种类：`view` = 渲染 schema（由我们的组件画）；`embed` = 插件自己的页面放进 iframe。 */
export type UiKind = "view" | "embed";

/**
 * 插件清单 `ui` 里的一项界面贡献。`id` 必须同时出现在 `permissions.ui.views`（kind view）
 * 或 `permissions.ui.embeds`（kind embed）里；`embed` 的页面由插件路由提供。
 */
export interface UiContribution {
  id: string;
  title: { zh: string; en: string };
  place: UiPlace;
  kind: UiKind;
  /** 仅 embed：插件路由下 `/ui/` 开头的路径，须在 `permissions.http` 中声明为 GET。 */
  path?: string;
  /** Icon from {@link UI_ICONS}; default `puzzle`. */
  icon?: UiIcon;
  /**
   * A retired id kept answering for a release: it is not listed, and fetching it renders (or
   * embeds) the named contribution of the same extension and kind. It still needs its entry in
   * `permissions.ui`, and no `ctx.ui.view` of its own.
   */
  aliasOf?: string;
}

/**
 * 渲染 schema 的块。文本是给人看的、按原样展示（插件自行决定语言，通常取 `locale`）。
 * `text.markdown` 不支持原生 HTML，链接只允许 http(s) 绝对地址。
 */
export type UiBlock =
  | { type: "heading"; text: string }
  | { type: "text"; markdown: string }
  | {
      type: "checklist";
      items: {
        text: string;
        status: "pending" | "in_progress" | "completed";
        /** Anchor for an open target's `item`. */
        id?: string;
        open?: UiOpen;
      }[];
    }
  | {
      type: "keyValue";
      items: { label: string; value: string; id?: string; open?: UiOpen }[];
    }
  | {
      type: "table";
      columns: { key: string; label: string }[];
      /**
       * 每行按列 key 取单元格，可以缺列。渲染时用 `Object.hasOwn(row, key)` 判断单元格是否存在，
       * 不要用 `row[key]` 或 `in`：列 key 可能是 `constructor` / `toString` 之类，会取到原型链上的值。
       */
      rows: Record<string, string>[];
      /** Per row (same index), an open target or null; never a key inside a row. */
      open?: (UiOpen | null)[];
    }
  | { type: "code"; language?: string; text: string }
  | { type: "image"; url: string; alt: string }
  | { type: "chart"; kind: "bar" | "line"; series: { label: string; value: number }[] }
  | {
      type: "actions";
      buttons: { actionId: string; label: string; payload?: unknown; danger?: boolean }[];
    }
  | { type: "form"; form: InputForm; actionId: string; submitLabel: string };

/** 插件视图：有上限的块列表；`badge` 显示在标签上（如「2/4」）。 */
export interface UiView {
  badge?: string;
  /** The ⤢ of an inline card's title row and a properties section's header. */
  open?: UiOpen;
  blocks: UiBlock[];
}

/**
 * 视图上限（{@link validateUiView} 统一检查）：
 * - `blocks`：块数；
 * - `tableRows`：表格行数，也用作 keyValue 项数、表格列数、图表点数、按钮数的上限；
 * - `checklistItems`：清单项数；
 * - `textChars`：整个视图所有文本（含表单 JSON）的字符总数；
 * - `payloadBytes`：单个按钮 `payload` 的 JSON 序列化后 UTF-8 字节数。
 */
export const UI_LIMITS = {
  blocks: 50,
  tableRows: 200,
  checklistItems: 100,
  textChars: 20000,
  payloadBytes: 2000,
} as const;

const BADGE_MAX = 32;
/** Longest item / block `id` and open target `item`. */
const ITEM_ID_MAX = 200;
/** A ui contribution id (same rule as the manifest's). */
const OPEN_ID_RE = /^[a-z][a-z0-9-]{0,39}$/;
const CHECK_STATUSES = ["pending", "in_progress", "completed"] as const;
const CHART_KINDS = ["bar", "line"] as const;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const MD_INLINE_LINK = /\]\(\s*<?([^\s)>]*)/g;
const MD_REF_DEF = /^ {0,3}\[[^\]\n]+\]:[ \t]*<?([^\s>]*)/gm;
const MD_AUTOLINK = /<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^<>\s]*)>/g;

/** Markdown 里的链接 / 图片目标（行内、引用定义、尖括号自动链接）。 */
function markdownLinks(md: string): string[] {
  const out: string[] = [];
  for (const re of [MD_INLINE_LINK, MD_REF_DEF, MD_AUTOLINK]) {
    for (const m of md.matchAll(re)) out.push(m[1] ?? "");
  }
  return out;
}

/** JSON 序列化后的 UTF-8 字节数；不可序列化返回 undefined。 */
function jsonBytes(v: unknown): number | undefined {
  try {
    const s = JSON.stringify(v);
    return typeof s === "string" ? new TextEncoder().encode(s).length : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 校验插件返回的视图，返回问题列表（空 = 合法）。链接与图片只允许 http(s) 绝对地址；
 * Markdown 的检查是纵深防御，网页渲染时仍须只认 http(s) 链接、不渲染原生 HTML。
 * 按钮与表单的 `actionId` 在整个视图内唯一（动作回调靠它区分来源）。
 */
export function validateUiView(v: unknown): string[] {
  if (!isObj(v)) return ["view must be an object"];
  const out: string[] = [];
  let chars = 0;
  const text = (at: string, s: unknown, nonEmpty = false): void => {
    if (typeof s !== "string" || (nonEmpty && s === "")) {
      out.push(`${at} must be a ${nonEmpty ? "non-empty " : ""}string`);
      return;
    }
    chars += s.length;
  };
  const actionIds = new Set<string>();
  const actionId = (at: string, id: unknown): void => {
    text(at, id, true);
    if (typeof id !== "string" || id === "") return;
    if (actionIds.has(id)) out.push(`${at} is a duplicate actionId "${id}" in this view`);
    actionIds.add(id);
  };
  const openTarget = (at: string, o: unknown): void => {
    if (!isObj(o)) {
      out.push(`${at} must be an object`);
      return;
    }
    if (typeof o.contribution !== "string" || !OPEN_ID_RE.test(o.contribution))
      out.push(`${at}.contribution must be a ui contribution id`);
    else chars += o.contribution.length;
    if (o.item !== undefined) {
      if (typeof o.item !== "string" || o.item === "" || o.item.length > ITEM_ID_MAX)
        out.push(`${at}.item must be a non-empty string of at most ${ITEM_ID_MAX} characters`);
      else chars += o.item.length;
    }
  };
  const anchor = (at: string, it: Record<string, unknown>): void => {
    if (it.id !== undefined) {
      if (typeof it.id !== "string" || it.id === "" || it.id.length > ITEM_ID_MAX)
        out.push(`${at}.id must be a non-empty string of at most ${ITEM_ID_MAX} characters`);
      else chars += it.id.length;
    }
    if (it.open !== undefined) openTarget(`${at}.open`, it.open);
  };
  const list = (at: string, xs: unknown, max: number): unknown[] => {
    if (!Array.isArray(xs)) {
      out.push(`${at} must be an array`);
      return [];
    }
    if (xs.length > max) out.push(`${at} must have at most ${max} entries`);
    return xs;
  };

  if (v.badge !== undefined) {
    if (typeof v.badge !== "string" || v.badge.length > BADGE_MAX)
      out.push(`badge must be a string of at most ${BADGE_MAX} characters`);
    else chars += v.badge.length;
  }
  if (v.open !== undefined) openTarget("open", v.open);
  const blocks = list("blocks", v.blocks, UI_LIMITS.blocks);
  blocks.forEach((b, i) => {
    const at = `blocks[${i}]`;
    if (!isObj(b)) {
      out.push(`${at} must be an object`);
      return;
    }
    switch (b.type) {
      case "heading":
        text(`${at}.text`, b.text, true);
        return;
      case "text": {
        text(`${at}.markdown`, b.markdown);
        if (typeof b.markdown === "string") {
          for (const link of markdownLinks(b.markdown)) {
            if (!isHttpUrl(link))
              out.push(`${at}.markdown has a link that is not an absolute http(s) URL`);
          }
        }
        return;
      }
      case "checklist":
        list(`${at}.items`, b.items, UI_LIMITS.checklistItems).forEach((it, j) => {
          const iat = `${at}.items[${j}]`;
          if (!isObj(it)) {
            out.push(`${iat} must be an object`);
            return;
          }
          text(`${iat}.text`, it.text, true);
          if (!(CHECK_STATUSES as readonly unknown[]).includes(it.status))
            out.push(`${iat}.status must be one of ${CHECK_STATUSES.join(", ")}`);
          anchor(iat, it);
        });
        return;
      case "keyValue":
        list(`${at}.items`, b.items, UI_LIMITS.tableRows).forEach((it, j) => {
          const iat = `${at}.items[${j}]`;
          if (!isObj(it)) {
            out.push(`${iat} must be an object`);
            return;
          }
          text(`${iat}.label`, it.label);
          text(`${iat}.value`, it.value);
          anchor(iat, it);
        });
        return;
      case "table": {
        const keys = new Set<string>();
        list(`${at}.columns`, b.columns, UI_LIMITS.tableRows).forEach((c, j) => {
          const cat = `${at}.columns[${j}]`;
          if (!isObj(c) || typeof c.key !== "string" || c.key === "") {
            out.push(`${cat}.key must be a non-empty string`);
            return;
          }
          if (keys.has(c.key)) out.push(`${cat}.key "${c.key}" is a duplicate`);
          keys.add(c.key);
          text(`${cat}.key`, c.key);
          text(`${cat}.label`, c.label);
        });
        const rows = list(`${at}.rows`, b.rows, UI_LIMITS.tableRows);
        rows.forEach((r, j) => {
          const rat = `${at}.rows[${j}]`;
          if (!isObj(r)) {
            out.push(`${rat} must be an object`);
            return;
          }
          for (const [k, cell] of Object.entries(r)) {
            if (!keys.has(k)) out.push(`${rat} has unknown column "${k}"`);
            text(`${rat}.${k}`, cell);
          }
        });
        if (b.open !== undefined) {
          const opens = list(`${at}.open`, b.open, rows.length);
          opens.forEach((o, j) => {
            if (o !== null) openTarget(`${at}.open[${j}]`, o);
          });
        }
        return;
      }
      case "code":
        if (b.language !== undefined) text(`${at}.language`, b.language, true);
        text(`${at}.text`, b.text);
        return;
      case "image":
        if (!isHttpUrl(b.url))
          out.push(`${at}.url must be an absolute http(s) URL of at most 2000 characters`);
        else chars += (b.url as string).length;
        text(`${at}.alt`, b.alt);
        return;
      case "chart":
        if (!(CHART_KINDS as readonly unknown[]).includes(b.kind))
          out.push(`${at}.kind must be one of ${CHART_KINDS.join(", ")}`);
        list(`${at}.series`, b.series, UI_LIMITS.tableRows).forEach((p, j) => {
          const pat = `${at}.series[${j}]`;
          if (!isObj(p)) {
            out.push(`${pat} must be an object`);
            return;
          }
          text(`${pat}.label`, p.label);
          if (typeof p.value !== "number" || !Number.isFinite(p.value))
            out.push(`${pat}.value must be a finite number`);
        });
        return;
      case "actions": {
        const buttons = list(`${at}.buttons`, b.buttons, UI_LIMITS.tableRows);
        if (Array.isArray(b.buttons) && buttons.length === 0)
          out.push(`${at}.buttons must not be empty`);
        buttons.forEach((btn, j) => {
          const bat = `${at}.buttons[${j}]`;
          if (!isObj(btn)) {
            out.push(`${bat} must be an object`);
            return;
          }
          actionId(`${bat}.actionId`, btn.actionId);
          text(`${bat}.label`, btn.label, true);
          if (btn.danger !== undefined && typeof btn.danger !== "boolean")
            out.push(`${bat}.danger must be a boolean`);
          if (btn.payload !== undefined) {
            const n = jsonBytes(btn.payload);
            if (n === undefined) out.push(`${bat}.payload must be JSON-serializable`);
            else if (n > UI_LIMITS.payloadBytes)
              out.push(`${bat}.payload must be at most ${UI_LIMITS.payloadBytes} bytes as JSON`);
          }
        });
        return;
      }
      case "form": {
        if (!isObj(b.form)) out.push(`${at}.form must be an object`);
        else {
          for (const p of validateInputForm(b.form as unknown as InputForm))
            out.push(`${at}.form: ${p}`);
          chars += jsonBytes(b.form) === undefined ? 0 : JSON.stringify(b.form).length;
        }
        actionId(`${at}.actionId`, b.actionId);
        text(`${at}.submitLabel`, b.submitLabel, true);
        return;
      }
      default:
        out.push(`${at}.type ${JSON.stringify(b.type)} is not a known block type`);
    }
  });
  if (chars > UI_LIMITS.textChars)
    out.push(`view text must be at most ${UI_LIMITS.textChars} characters in total`);
  return out;
}

/**
 * 调用者在组织内的角色（由高到低 owner / admin / member / guest）。`place: "page"` 的贡献只给 member 以上
 * （内核对 guest 返回 404，插件收不到 guest 的组织页面请求）；对话位置的贡献给能访问该对话的任何角色。
 */
export type UiRole = "owner" | "admin" | "member" | "guest";

/** 内核调用插件 `render` 时传入的参数（身份由内核鉴权后给出，插件拿不到用户的会话凭据）。 */
export interface UiRenderArgs {
  orgId: string;
  accountId: string;
  /** 调用者此刻在 `orgId` 的角色（内核按成员关系填，插件可据此收紧按钮等，见 {@link UiRole}）。 */
  role: UiRole;
  /** 仅对话视图。 */
  conversationId?: string;
  locale: Locale;
  signal: AbortSignal;
  /** A panel opened from an open target: the block or item `id` to scroll to. */
  item?: string;
  /**
   * An inline card: the tool call it hangs off and the `key` from `ToolResult.card`. Attested by the
   * kernel: given only to an `inline` view, and only when a `tool_result` of `conversationId`
   * recorded this very card (same extension, view and key); scope lookups by `conversationId` too.
   */
  card?: { callId: string; key?: string };
}

/** 视图里的按钮或表单提交：`actionId` 来自块；表单提交时带 `answer`。 */
export interface UiActionArgs extends UiRenderArgs {
  actionId: string;
  payload?: unknown;
  answer?: FormAnswer;
}

/** 动作结果：一条提示，或一份新的视图。 */
export type UiActionResult = { toast?: { zh: string; en: string } } | { view: UiView };

/** 嵌入令牌里的声明（经 `ctx.ui.verifyEmbedToken` 校验后可信）。`exp` 为 Unix 秒。 */
export interface EmbedClaims {
  plugin: string;
  orgId: string;
  accountId: string;
  /** 调用者的角色：签发时写入；`ctx.ui.verifyEmbedToken` 返回校验时刻的当前角色。 */
  role: UiRole;
  conversationId?: string;
  /** Only a `file-preview` embed's token: the one file (of `conversationId`) it previews. */
  fileId?: string;
  contribution: string;
  exp: number;
}

/** 外层页面与嵌入 iframe 之间 `postMessage` 协议的版本标识。 */
export const EMBED_PROTOCOL = "capybara-embed/1";

/** 外层页面发给 iframe 的消息。 */
export type EmbedParentMessage =
  | {
      protocol: typeof EMBED_PROTOCOL;
      type: "init";
      token: string;
      locale: Locale;
      theme: "dark" | "light";
      tokens: Record<string, string>;
      context: { orgId: string; conversationId?: string };
    }
  | { protocol: typeof EMBED_PROTOCOL; type: "token"; token: string }
  | {
      protocol: typeof EMBED_PROTOCOL;
      type: "theme";
      theme: "dark" | "light";
      tokens: Record<string, string>;
    }
  /**
   * Only to a `file-preview` embed, once, after `init`: the file being previewed. The embed never
   * gets a URL for it.
   */
  | {
      protocol: typeof EMBED_PROTOCOL;
      type: "file";
      name: string;
      contentType: string;
      size: number;
      data: ArrayBuffer;
    };

/** iframe 发给外层页面的消息。 */
export type EmbedChildMessage =
  /** 高度为 CSS 像素，0–10000。 */
  | { protocol: typeof EMBED_PROTOCOL; type: "resize"; height: number }
  /** 只允许站内路径：单个 `/` 开头、没有 `//`、没有 `.` / `..` 段（含 `%2e` 编码）、规范化后不变。 */
  | { protocol: typeof EMBED_PROTOCOL; type: "navigate"; path: string }
  | { protocol: typeof EMBED_PROTOCOL; type: "toast"; text: string };

const NAV_MAX = 2000;
const RESIZE_MAX = 10000;
const TOAST_MAX = 500;
// capybara:embed-nav-begin（这一段在 packages/plugin-sdk/src/ui.ts 与 apps/web/src/lib/embed-bridge.ts 里逐字相同，有测试核对）
// 控制字符与反斜杠：浏览器会把 `/\host` 当成 `//host`，也会剥掉路径里的换行 / 制表符
// biome-ignore lint/suspicious/noControlCharactersInRegex: 正是要拒绝控制字符
const NAV_BAD = /[\u0000-\u001f\u007f\\]/;
/** 路径部分里编码的 `/`、`\` 与控制字符（任意大小写）：解码后会改变路径结构。 */
const NAV_BAD_ENCODED = /%(?:2f|5c|[01][0-9a-f]|7f)/i;

/**
 * 站内路径：以单个 `/` 开头，任何位置都没有 `//`，没有控制字符与反斜杠；路径部分没有 `.` / `..` 段
 * （含任意大小写的 `%2e` 编码），也没有编码的 `/`（`%2f`）、`\`（`%5c`）与控制字符（`%00`–`%1f`、`%7f`）；
 * 且按 URL 规范化后与原文完全相同、不以 `//` 开头——规范化不会把它变成别的路径，
 * 交给站内路由时不会跳到站外或上层目录。
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

/**
 * 解析 iframe 发来的消息：协议、类型、字段都对才返回（只留已知字段的新对象），否则返回 null。
 * 外层页面还须先核对消息来源是这个 iframe。
 */
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
