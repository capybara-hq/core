import type { LocalizedName } from "./plugin-package.js";
import type { LocalizedText } from "./tool.js";
import { UI_LIMITS } from "./ui.js";

/**
 * One button on an inbox item: clicking it calls `uiAction.actionId` of the extension's UI
 * contribution `uiAction.contribution` (registered with `ctx.ui.action`) as the person who
 * clicked, with `payload`, then resolves the item. The contribution must be one of an org-wide
 * slot (such as `org.page`): the call carries no conversation or agent. The action must be
 * idempotent: delivery is at least once (a click whose result was lost may be pressed again).
 */
export interface InboxAction {
  /** Unique within the item ({@link INBOX_ID_RE}). */
  id: string;
  label: LocalizedName;
  style?: "primary" | "danger";
  uiAction: { contribution: string; actionId: string; payload?: unknown };
}

/** A personal inbox item an extension posts through `ctx.inbox.post`. */
export interface InboxPost {
  orgId: string;
  /** The one person the item is for: an active member of `orgId`. */
  accountId: string;
  /** What kind of item it is, for the extension ({@link INBOX_KIND_RE}). */
  kind: string;
  /**
   * A single string shown as is, or `{ zh, en }` shown in the reader's language; each text at
   * most {@link INBOX_LIMITS}.titleChars characters.
   */
  title: LocalizedText;
  /**
   * A single string or `{ zh, en }`, like `title`; each text at most
   * {@link INBOX_LIMITS}.bodyChars characters.
   */
  body?: LocalizedText;
  /**
   * An in-app path opened from the item: an extension's item may only link to its own pages,
   * `/p/<extension name>/...` (at most {@link INBOX_LIMITS}.linkChars characters).
   */
  link?: string;
  /** At most {@link INBOX_ACTIONS_MAX}. */
  actions?: InboxAction[];
  /**
   * Seconds until the item expires and leaves the inbox (default
   * {@link INBOX_LIMITS}.defaultExpirySeconds, at most {@link INBOX_LIMITS}.maxExpirySeconds).
   */
  expiresInSeconds?: number;
  /**
   * Idempotency key: while an item of this extension with the same key is open for the same
   * person in the same org, a post returns that item instead of adding another.
   */
  dedupeKey?: string;
}

/** `ctx.inbox` (requires `permissions.inbox`): personal inbox items. */
export interface InboxCtx {
  /** Posts an item for one person (see {@link InboxPost}); the person's push settings apply. */
  post(p: InboxPost): Promise<{ itemId: string }>;
  /** Resolves an open item this extension posted (an item already closed is left as it is). */
  resolve(args: { orgId: string; itemId: string }): Promise<void>;
}

export type InboxErrorCode = "invalid_item" | "org_disabled" | "not_found";

/** A {@link InboxCtx} call was refused. */
export class InboxError extends Error {
  readonly code: InboxErrorCode;

  constructor(code: InboxErrorCode, message: string, opts?: { cause?: unknown }) {
    super(message, opts && "cause" in opts ? { cause: opts.cause } : undefined);
    this.name = "InboxError";
    this.code = code;
  }
}

/** The most actions one inbox item carries. */
export const INBOX_ACTIONS_MAX = 3;

/** Limits of an inbox item. */
export const INBOX_LIMITS = {
  titleChars: 200,
  bodyChars: 2000,
  linkChars: 512,
  kindChars: 64,
  labelChars: 40,
  idChars: 64,
  dedupeKeyChars: 200,
  /** UTF-8 bytes of one action's `payload` as JSON (as a UI button's). */
  payloadBytes: UI_LIMITS.payloadBytes,
  defaultExpirySeconds: 30 * 24 * 3600,
  maxExpirySeconds: 90 * 24 * 3600,
} as const;

/** The shape of an item's `kind`: dotted lower-case words. */
export const INBOX_KIND_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;

/** The shape of an action id, a contribution id and a UI action id. */
export const INBOX_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/**
 * Checks a post before it is stored; returns error codes (empty = valid): `missing_<field>`,
 * `<field>_too_long`, `title_invalid` / `body_invalid` (not a string or `{ zh, en }`),
 * `kind_invalid`, `link_invalid` (not a path of the extension's own pages
 * `/p/<plugin>/`), `too_many_actions`, `action_invalid`, `action_duplicate`, `payload_too_large`,
 * `expiry_invalid`. `plugin` is the posting extension's name.
 */
export function validateInboxPost(p: InboxPost, plugin: string): string[] {
  const errs: string[] = [];
  const str = (v: unknown): v is string => typeof v === "string";
  const blank = (v: unknown): boolean => !str(v) || v.trim() === "";
  if (blank(p.orgId)) errs.push("missing_org_id");
  if (blank(p.accountId)) errs.push("missing_account_id");
  if (blank(p.kind)) errs.push("missing_kind");
  else if (p.kind.length > INBOX_LIMITS.kindChars || !INBOX_KIND_RE.test(p.kind))
    errs.push("kind_invalid");
  const title = textProblem(p.title, INBOX_LIMITS.titleChars, true);
  if (title !== null) errs.push(`${title === "missing" ? "missing_title" : `title_${title}`}`);
  if (p.body !== undefined) {
    const body = textProblem(p.body, INBOX_LIMITS.bodyChars, false);
    if (body !== null) errs.push(body === "missing" ? "body_invalid" : `body_${body}`);
  }
  if (p.link !== undefined) {
    if (!str(p.link) || p.link.length > INBOX_LIMITS.linkChars || !ownPageLink(p.link, plugin))
      errs.push("link_invalid");
  }
  if (p.dedupeKey !== undefined) {
    if (blank(p.dedupeKey) || (p.dedupeKey as string).length > INBOX_LIMITS.dedupeKeyChars)
      errs.push("dedupe_key_invalid");
  }
  if (p.expiresInSeconds !== undefined) {
    const s = p.expiresInSeconds;
    if (typeof s !== "number" || !Number.isInteger(s) || s < 1 || s > INBOX_LIMITS.maxExpirySeconds)
      errs.push("expiry_invalid");
  }
  if (p.actions !== undefined) {
    if (!Array.isArray(p.actions)) errs.push("action_invalid");
    else {
      if (p.actions.length > INBOX_ACTIONS_MAX) errs.push("too_many_actions");
      const ids = new Set<string>();
      for (const a of p.actions) {
        const problem = actionProblem(a);
        if (problem !== null) {
          errs.push(problem);
          continue;
        }
        if (ids.has(a.id)) errs.push("action_duplicate");
        ids.add(a.id);
      }
    }
  }
  return [...new Set(errs)];
}

/**
 * What is wrong with a title or body (a string, or `{ zh, en }` with both strings): `missing` (a
 * required text that is not a string or object, or blank), `invalid` (an object with another
 * shape, or a blank language of a required text), `too_long`; null when it is fine.
 */
function textProblem(
  v: unknown,
  max: number,
  required: boolean,
): "missing" | "invalid" | "too_long" | null {
  const blank = (t: string) => required && t.trim() === "";
  if (typeof v === "string") {
    if (blank(v)) return "missing";
    return v.length > max ? "too_long" : null;
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return "missing";
  const keys = Object.keys(v);
  const { zh, en } = v as { zh?: unknown; en?: unknown };
  if (keys.length !== 2 || typeof zh !== "string" || typeof en !== "string") return "invalid";
  if (blank(zh) || blank(en)) return "invalid";
  return zh.length > max || en.length > max ? "too_long" : null;
}

const idOk = (v: unknown): boolean =>
  typeof v === "string" && v.length <= INBOX_LIMITS.idChars && INBOX_ID_RE.test(v);

const labelOk = (v: unknown): boolean =>
  typeof v === "string" && v.trim() !== "" && v.length <= INBOX_LIMITS.labelChars;

function actionProblem(a: unknown): string | null {
  if (typeof a !== "object" || a === null) return "action_invalid";
  const x = a as Partial<InboxAction>;
  if (!idOk(x.id)) return "action_invalid";
  if (typeof x.label !== "object" || x.label === null) return "action_invalid";
  if (!labelOk(x.label.zh) || !labelOk(x.label.en)) return "action_invalid";
  if (x.style !== undefined && x.style !== "primary" && x.style !== "danger")
    return "action_invalid";
  const u = x.uiAction;
  if (typeof u !== "object" || u === null) return "action_invalid";
  if (!idOk(u.contribution) || !idOk(u.actionId)) return "action_invalid";
  if (u.payload !== undefined) {
    let json: string | undefined;
    try {
      json = JSON.stringify(u.payload);
    } catch {
      return "action_invalid";
    }
    if (json === undefined) return "action_invalid";
    if (new TextEncoder().encode(json).length > INBOX_LIMITS.payloadBytes)
      return "payload_too_large";
  }
  return null;
}

/**
 * Whether `link` is a path of the extension's own pages: `/p/<plugin>/` followed by at least one
 * character, with no backslash or control character, no dot segment (`.`, `..`, also spelled with
 * `%2e` in any case), and a path that still starts with `/p/<plugin>/` once a URL parser resolved
 * it.
 */
function ownPageLink(link: string, plugin: string): boolean {
  const prefix = `/p/${plugin}/`;
  if (!link.startsWith(prefix) || link.length === prefix.length) return false;
  if (/[\\\p{Cc}]/u.test(link)) return false;
  const path = link.split(/[?#]/, 1)[0] ?? "";
  const dot = (s: string) => {
    const d = s.replace(/%2e/gi, ".");
    return d === "." || d === "..";
  };
  if (path.split("/").some(dot)) return false;
  try {
    return new URL(link, "http://x").pathname.startsWith(prefix);
  } catch {
    return false;
  }
}
