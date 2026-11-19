import type { Locale } from "./cards.js";
import { type FormAnswer, type InputForm, validateInputForm } from "./tool.js";
import type { CompactForm, UiSlotId, UiSlotScope } from "./ui-slots.js";
import { isHttpUrl } from "./url.js";

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
 * An "open" target: a `conversation.panel` contribution of the same extension, scrolled to the
 * block or item whose `id` equals `item` (the panel's render receives it as
 * {@link UiRenderArgs.item}).
 */
export interface UiOpen {
  contribution: string;
  item?: string;
}

/**
 * The kind of a UI contribution: `view` = a render schema drawn by the host's components; `embed` =
 * the extension's own page in an iframe; `component` = a React component from the extension's
 * client code (client extensions spec §5).
 */
export type UiKind = "view" | "embed" | "component";

/**
 * One UI contribution of the extension manifest's `ui`. Its `id` must be listed in the list of its
 * kind: `permissions.ui.views` (view), `permissions.ui.embeds` (embed) or
 * `permissions.ui.components` (component, which also needs `permissions.client: true`); an embed's
 * page is served by an extension route.
 */
export interface UiContribution {
  id: string;
  title: { zh: string; en: string };
  /**
   * The slot it goes in: `"<id>"` (version 1) or `"<id>@<n>"`, an id of `UI_SLOTS`. Required. An
   * unknown slot or version does not fail the extension: the contribution is dropped (see
   * `resolveUiSlots`).
   */
  slot: string;
  /**
   * One of the slot's `anchors` to be placed after; omitted (or not an anchor of the slot) = the
   * slot's first anchor.
   */
  after?: string;
  kind: UiKind;
  /** Embed only: a path under `/ui/` of the extension's routes, declared in `permissions.http` as GET. */
  path?: string;
  /** Icon from {@link UI_ICONS}; default `puzzle`. */
  icon?: UiIcon;
  /**
   * The form on a compact screen; may only narrow the slot's own (`kept` -> `drawer` -> `hidden`),
   * see `effectiveCompact`. Omitted = the slot's form.
   */
  compact?: CompactForm;
}

/**
 * Blocks of the render schema. Text is for humans and shown as is (the plugin decides the language
 * itself, usually taking `locale`).
 * `text.markdown` does not support native HTML, and links may only be absolute http(s) addresses.
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
       * Each row takes its cell by column key, and a column may be missing. When rendering, use
       * `Object.hasOwn(row, key)` to tell whether a cell exists,
       * do not use `row[key]` or `in`: a column key may be `constructor` / `toString` and the like,
       * which would pick up values from the prototype chain.
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

/** A JSON value: what survives `JSON.stringify` and `JSON.parse` unchanged. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** A plugin view: a block list with limits; `badge` is shown on the tab (e.g. "2/4"). */
export interface UiView {
  badge?: string;
  /** The ⤢ of an inline card's title row and a properties section's header. */
  open?: UiOpen;
  /** A component's view may have no blocks (`[]`). */
  blocks: UiBlock[];
  /**
   * Only from a component's render (`useView` hands it to the component): at most
   * `UI_LIMITS.componentDataBytes` bytes of JSON. Refused in the views of the other kinds.
   */
  data?: JsonValue;
}

/**
 * View limits (checked uniformly by {@link validateUiView}):
 * - `blocks`: number of blocks;
 * - `tableRows`: number of table rows, also used as the upper bound for keyValue items, table
 *   columns, chart points and buttons;
 * - `checklistItems`: number of checklist items;
 * - `textChars`: total characters of all text in the whole view (form JSON included);
 * - `payloadBytes`: UTF-8 bytes of a single button `payload` after JSON serialization.
 * - `componentDataBytes`: the UTF-8 bytes of a component view's `data` as JSON.
 */
export const UI_LIMITS = {
  blocks: 50,
  tableRows: 200,
  checklistItems: 100,
  textChars: 20000,
  payloadBytes: 2000,
  componentDataBytes: 32768,
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

/** Link / image targets in Markdown (inline, reference definitions, angle-bracket autolinks). */
function markdownLinks(md: string): string[] {
  const out: string[] = [];
  for (const re of [MD_INLINE_LINK, MD_REF_DEF, MD_AUTOLINK]) {
    for (const m of md.matchAll(re)) out.push(m[1] ?? "");
  }
  return out;
}

/** UTF-8 bytes after JSON serialization; undefined when not serializable. */
function jsonBytes(v: unknown): number | undefined {
  try {
    const s = JSON.stringify(v);
    return typeof s === "string" ? new TextEncoder().encode(s).length : undefined;
  } catch {
    return undefined;
  }
}

const JSON_KINDS = "null, booleans, finite numbers, strings, arrays, plain objects";

/**
 * The first part of `v` (`at` is its path) that JSON would not carry as is, or undefined: a value
 * `JSON.stringify` drops, rewrites or throws on (a function, symbol or bigint, NaN or ±Infinity,
 * `undefined` in an array, an object that is not plain such as a Map or a Date, a cycle). A plain
 * object's `undefined` property is accepted: JSON drops it, which reads as an absent optional field.
 */
function jsonProblem(v: unknown, at: string, seen: Set<object> = new Set()): string | undefined {
  if (v === null || typeof v === "boolean" || typeof v === "string") return undefined;
  if (typeof v === "number") return Number.isFinite(v) ? undefined : `${at} is ${v}`;
  if (v === undefined) return `${at} is undefined`;
  if (typeof v !== "object") return `${at} is a ${typeof v}`;
  if (seen.has(v)) return `${at} is a cycle`;
  seen.add(v);
  try {
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) {
        const p = jsonProblem(v[i], `${at}[${i}]`, seen);
        if (p !== undefined) return p;
      }
      return undefined;
    }
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) {
      return `${at} is a ${(proto as { constructor?: { name?: string } }).constructor?.name || "non-plain object"}`;
    }
    for (const [k, x] of Object.entries(v)) {
      if (x === undefined) continue;
      const p = jsonProblem(x, `${at}.${k}`, seen);
      if (p !== undefined) return p;
    }
    return undefined;
  } finally {
    seen.delete(v);
  }
}

/**
 * Validates the view a plugin returns and returns the list of problems (empty = valid). Links and
 * images may only be absolute http(s) addresses;
 * the Markdown check is defense in depth, and web rendering must still accept only http(s) links
 * and not render native HTML.
 * The `actionId` of buttons and forms is unique within the whole view (action callbacks tell the
 * source by it).
 * `data` is accepted only with `opts.component` (the view of a component contribution): JSON as is
 * (nothing JSON would drop or rewrite, see `jsonProblem`), up to `UI_LIMITS.componentDataBytes`
 * bytes of UTF-8.
 */
export function validateUiView(v: unknown, opts: { component?: boolean } = {}): string[] {
  if (!isObj(v)) return ["view must be an object"];
  const out: string[] = [];
  if (v.data !== undefined) {
    if (opts.component !== true) out.push("view data is only allowed for component views");
    else {
      const problem = jsonProblem(v.data, "data");
      if (problem !== undefined) out.push(`view data must be JSON (${JSON_KINDS}): ${problem}`);
      else {
        const n = jsonBytes(v.data) ?? 0;
        if (n > UI_LIMITS.componentDataBytes)
          out.push(`view data is ${n} bytes; the limit is ${UI_LIMITS.componentDataBytes}`);
      }
    }
  }
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
 * The caller's role in the org (owner / admin / member / guest, highest first). A slot's `minRole`
 * decides who may use its contributions, then its scope's rule (the kernel answers 404 to anyone
 * else, so the extension never sees such a request): `org.page` member and up,
 * `org.settings.section` admin and up; conversation slots any role that can read the
 * conversation; `agent.detail.section` any role that can read the agent (read-only viewers
 * included: tighten on `role` if you must).
 */
export type UiRole = "owner" | "admin" | "member" | "guest";

/** The render args every scope shares (identity comes from the kernel's auth, never the caller's credentials). */
export interface UiRenderArgsBase {
  accountId: string;
  /** The catalog slot the contribution resolved to. */
  slot: UiSlotId;
  locale: Locale;
  signal: AbortSignal;
  /**
   * The extension's effective deployment config: for an org, the platform's deployment config
   * with the org's copy applied to the overridable fields (`orgAccess(…, "override")`), or the
   * platform's config (equal to `ctx.config`) while the org follows it; for the platform scope,
   * the platform's config. Use it, not `ctx.config`, for work done for this org. Optional in the
   * type so older extensions compile; the kernel always passes it.
   */
  config?: unknown;
}

/**
 * The parameters passed when the kernel calls the plugin's `render`: the position within the org
 * (conversation, agent, org, file).
 */
export interface UiOrgRenderArgs extends UiRenderArgsBase {
  /** The scope of {@link slot}: which of the context ids below are set. */
  scope: Exclude<UiSlotScope, "platform">;
  orgId: string;
  /**
   * The caller's role in `orgId` at this moment (filled by the kernel from membership; a plugin may
   * use it to tighten buttons etc., see {@link UiRole}).
   */
  role: UiRole;
  /** Conversation views only. */
  conversationId?: string;
  /** Only an agent view (`agent.detail.section`): an agent of `orgId` the caller can read. */
  agentId?: string;
  /** A panel opened from an open target: the block or item `id` to scroll to. */
  item?: string;
  /**
   * An inline card: the tool call it hangs off and the `key` from `ToolResult.card`. Attested by the
   * kernel: given only to an `inline` view, and only when a `tool_result` of `conversationId`
   * recorded this very card (same extension, view and key); scope lookups by `conversationId` too.
   */
  card?: { callId: string; key?: string };
}

/**
 * The render args of a `platform.page` contribution: rendered for a super admin in the admin
 * console, with no org (and so no org role, conversation or agent).
 */
export interface UiPlatformRenderArgs extends UiRenderArgsBase {
  scope: "platform";
  orgId?: undefined;
  role: "superAdmin";
  conversationId?: undefined;
  agentId?: undefined;
  item?: undefined;
  card?: undefined;
}

/**
 * The parameters passed when the kernel calls the plugin's `render`: narrow on `scope`
 * (`"platform"` has no `orgId`).
 */
export type UiRenderArgs = UiOrgRenderArgs | UiPlatformRenderArgs;

/** What a button or form submit adds to the render args. */
export interface UiActionInput {
  actionId: string;
  payload?: unknown;
  answer?: FormAnswer;
}

/** An action of an org-scope view. */
export interface UiOrgActionArgs extends UiOrgRenderArgs, UiActionInput {}
/** An action of a `platform.page` view. */
export interface UiPlatformActionArgs extends UiPlatformRenderArgs, UiActionInput {}
/**
 * A button or form submission in a view: `actionId` comes from the block; a form submission carries
 * `answer`.
 */
export type UiActionArgs = UiOrgActionArgs | UiPlatformActionArgs;

/** An action result: a notice, or a new view. */
export type UiActionResult = { toast?: { zh: string; en: string } } | { view: UiView };

/** The embed claims every scope shares. `exp` is Unix seconds. */
export interface EmbedClaimsBase {
  plugin: string;
  contribution: string;
  exp: number;
}

/** An org-scope embed token's claims (every slot but `platform.page`). */
export interface OrgEmbedClaims extends EmbedClaimsBase {
  scope: "org";
  orgId: string;
  accountId: string;
  /**
   * The caller's role: written at issuance; `ctx.ui.verifyEmbedToken` returns the current role at
   * validation time.
   */
  role: UiRole;
  conversationId?: string;
  /** Only an agent embed's token (`agent.detail.section`): the agent it was issued for. */
  agentId?: string;
  /** Only a `file-preview` embed's token: the one file (of `conversationId`) it previews. */
  fileId?: string;
}

/** A `platform.page` embed token's claims: a super admin's, with no org, conversation, agent or file. */
export interface PlatformEmbedClaims extends EmbedClaimsBase {
  scope: "platform";
  accountId: string;
  orgId?: undefined;
  role: "superAdmin";
  conversationId?: undefined;
  agentId?: undefined;
  fileId?: undefined;
}

/**
 * A share page's `file.preview` embed token's claims: no account and no role, only the org, the
 * share and the share's generation. Valid only for the `file.preview` slot, never for `/api`.
 */
export interface ShareEmbedClaims extends EmbedClaimsBase {
  scope: "share";
  orgId: string;
  shareId: string;
  generation: number;
  accountId?: undefined;
  role?: undefined;
  conversationId?: undefined;
  agentId?: undefined;
  fileId?: undefined;
}

/**
 * Claims in an embed token (trustworthy after validation by `ctx.ui.verifyEmbedToken`): narrow on
 * `scope` (`"platform"` has no `orgId` and `role` `"superAdmin"`; `"share"` has no account or role).
 */
export type EmbedClaims = OrgEmbedClaims | PlatformEmbedClaims | ShareEmbedClaims;

/**
 * The version marker of the `postMessage` protocol between the outer page and the embedded iframe.
 */
export const EMBED_PROTOCOL = "capybara-embed/1";

/**
 * What an embed's `init` says about where it is shown, narrowed on `scope` like {@link EmbedClaims}:
 * an org's page, panel, section or previewer (`orgId`, and the conversation when there is one), or
 * a platform page of the admin console (no org), or a share page (no org or conversation).
 */
export type EmbedInitContext =
  | { scope: "org"; orgId: string; conversationId?: string }
  | { scope: "platform"; orgId?: undefined; conversationId?: undefined }
  | { scope: "share"; orgId?: undefined; conversationId?: undefined };

/** Messages the outer page sends to the iframe. */
export type EmbedParentMessage =
  | {
      protocol: typeof EMBED_PROTOCOL;
      type: "init";
      token: string;
      locale: Locale;
      theme: "dark" | "light";
      tokens: Record<string, string>;
      context: EmbedInitContext;
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

/** Messages the iframe sends to the outer page. */
export type EmbedChildMessage =
  /** Height in CSS pixels, 0–10000. */
  | { protocol: typeof EMBED_PROTOCOL; type: "resize"; height: number }
  /**
   * Only in-site paths: a single leading `/`, no `//`, no `.` / `..` segments (including `%2e`
   * encoding), unchanged after normalization.
   */
  | { protocol: typeof EMBED_PROTOCOL; type: "navigate"; path: string }
  | { protocol: typeof EMBED_PROTOCOL; type: "toast"; text: string };

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

/**
 * Parses a message sent by the iframe: returns it only when protocol, type and fields are all right
 * (a new object keeping only known fields), otherwise null.
 * The outer page must also first check that the message source is this iframe.
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
