import type { ThemeRef, ThemeScheme } from "./themes";

/**
 * The brand cookie (theme brand coverage spec §5): the theme this browser last drew under a
 * route-group layout, written by `ThemeRoot` in the browser, read by the pages outside those
 * layouts (the kernel-starting frame, the root error pages, the root 404) through
 * `outsideTheme()`. A hint only: never an input to access or to a kernel call.
 *
 * It is attacker-controllable input that reaches attributes (`<link href>`, `<img src>`) and a CSS
 * custom property, so {@link decodeBrandCookie} takes nothing outside the kernel's theme delivery
 * grammar, and a single invalid field discards the whole cookie. One codec for the server and the
 * browser.
 */
export const BRAND_COOKIE = "cb-brand";

/** 30 days, in seconds; renewed on every themed document. */
export const BRAND_COOKIE_MAX_AGE = 2_592_000;

/** The longest cookie value read or written, in characters (base64url, so also bytes). */
const MAX_COOKIE_CHARS = 1024;

/** The cookie format's version. */
const VERSION = 1;

/** What an outside page draws of a theme: its stylesheet and brand (a subset of `ThemeRef`). */
export interface BrandRef {
  cssUrl: string;
  markUrl: string | null;
  wordmark: string | null;
  illustrationUrl: string | null;
  faviconUrl: string | null;
  decoration: "dither" | "none";
  background: { dark?: string; light?: string };
}

/** What an outside page draws of `theme`. */
export function brandRefOf(theme: ThemeRef): BrandRef {
  return {
    cssUrl: theme.cssUrl,
    markUrl: theme.logo?.markUrl ?? null,
    wordmark: theme.logo?.wordmark ?? null,
    illustrationUrl: theme.logo?.illustrationUrl ?? null,
    faviconUrl: theme.logo?.faviconUrl ?? null,
    decoration: theme.decoration === "none" ? "none" : "dither",
    background: { ...theme.background },
  };
}

// The delivery grammar of the kernel (`themeUrl` in packages/kernel/src/themes/theme-state.ts and
// the routes of themes-public.controller.ts): `/api/v1/themes/<uuid>/<int>/r<int>/theme.css` and
// `/api/v1/themes/<uuid>/<int>/assets/<segment>`, where the segment is the plugin path with `/`
// as `%2F` and every part `[A-Za-z0-9._-]` (the SDK's asset path rule), never `.` or `..`. Same
// origin (a path), no query, no fragment, no other escape.
const THEME_BASE =
  "/api/v1/themes/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[1-9][0-9]{0,9}";
const CSS_URL_RE = new RegExp(`^${THEME_BASE}/r[1-9][0-9]{0,3}/theme\\.css$`);
const ASSET_URL_RE = new RegExp(`^${THEME_BASE}/assets/([A-Za-z0-9._%-]+)$`);
const ASSET_PART_RE = /^[A-Za-z0-9._-]+$/;

const isCssUrl = (v: unknown): v is string => typeof v === "string" && CSS_URL_RE.test(v);

function isAssetUrl(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const segment = ASSET_URL_RE.exec(v)?.[1];
  if (segment === undefined) return false;
  return segment
    .split("%2F")
    .every((part) => ASSET_PART_RE.test(part) && part !== "." && part !== "..");
}

// The SDK's wordmark rule (`shortText` in packages/plugin-sdk/src/theme.ts; apps/web imports no
// SDK): not blank, at most 24 characters, no control, format, line / paragraph separator or lone
// surrogate characters.
const WORDMARK_MAX = 24;
const FORBIDDEN_CHARS_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u;
const isWordmark = (v: unknown): v is string =>
  typeof v === "string" &&
  /\S/.test(v) &&
  [...v].length <= WORDMARK_MAX &&
  !FORBIDDEN_CHARS_RE.test(v);

// The SDK's canonical colour (`parseColor` in packages/plugin-sdk/src/theme.ts, which the kernel's
// `ThemeRef.background` comes from): `#RRGGBB` upper case or `rgba(r,g,b,a)` without spaces.
const HEX_RE = /^#[0-9A-F]{6}$/;
const RGBA_RE = /^rgba\(([0-9]{1,3}),([0-9]{1,3}),([0-9]{1,3}),(0|1|0\.[0-9]{1,4})\)$/;
function isColor(v: unknown): v is string {
  if (typeof v !== "string") return false;
  if (HEX_RE.test(v)) return true;
  const m = RGBA_RE.exec(v);
  if (m === null) return false;
  // canonical only: each part as the SDK renders it (no leading zeros, no trailing alpha zeros)
  const parts = [m[1], m[2], m[3], m[4]] as string[];
  return (
    parts.every((p) => String(Number(p)) === p) && parts.slice(0, 3).every((c) => Number(c) <= 255)
  );
}

const SCHEMES: readonly ThemeScheme[] = ["dark", "light"];
const FIELDS = new Set([
  "v",
  "cssUrl",
  "markUrl",
  "wordmark",
  "illustrationUrl",
  "faviconUrl",
  "decoration",
  "background",
]);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const nullOr = <T>(v: unknown, is: (x: unknown) => x is T): v is T | null => v === null || is(v);

/** `value` as a {@link BrandRef} when every field is in the grammar, else null. */
function brandRefFrom(value: unknown): BrandRef | null {
  if (!isRecord(value) || value.v !== VERSION) return null;
  if (Object.keys(value).some((k) => !FIELDS.has(k))) return null;
  const { cssUrl, markUrl, wordmark, illustrationUrl, faviconUrl, decoration, background } = value;
  if (!isCssUrl(cssUrl)) return null;
  if (!nullOr(markUrl, isAssetUrl) || !nullOr(illustrationUrl, isAssetUrl)) return null;
  if (!nullOr(faviconUrl, isAssetUrl) || !nullOr(wordmark, isWordmark)) return null;
  if (decoration !== "dither" && decoration !== "none") return null;
  if (!isRecord(background)) return null;
  const bg: BrandRef["background"] = {};
  for (const [scheme, color] of Object.entries(background)) {
    if (!SCHEMES.includes(scheme as ThemeScheme) || !isColor(color)) return null;
    bg[scheme as ThemeScheme] = color;
  }
  return { cssUrl, markUrl, wordmark, illustrationUrl, faviconUrl, decoration, background: bg };
}

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

function toBase64Url(text: string): string {
  let bin = "";
  for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(raw: string): string | null {
  try {
    const bin = atob(raw.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** The cookie value of `ref`: base64url JSON with the version; null when over 1 KB or invalid. */
export function encodeBrandCookie(ref: BrandRef): string | null {
  const valid = brandRefFrom({ v: VERSION, ...ref });
  if (valid === null) return null;
  const raw = toBase64Url(JSON.stringify({ v: VERSION, ...valid }));
  return raw.length > MAX_COOKIE_CHARS ? null : raw;
}

/** The brand a cookie value holds; null when absent or when any part of it is invalid. */
export function decodeBrandCookie(raw: string | undefined): BrandRef | null {
  if (raw === undefined || raw.length > MAX_COOKIE_CHARS || !BASE64URL_RE.test(raw)) return null;
  const text = fromBase64Url(raw);
  if (text === null) return null;
  try {
    return brandRefFrom(JSON.parse(text));
  } catch {
    return null;
  }
}

/**
 * The `document.cookie` string that stores `ref` (`Path=/`, `SameSite=Lax`, 30 days, `Secure` on
 * https), or deletes the cookie when `ref` is null (the built-in theme) or cannot be stored.
 */
export function brandCookieHeader(ref: BrandRef | null, secure: boolean): string {
  const raw = ref === null ? null : encodeBrandCookie(ref);
  const value =
    raw === null
      ? `${BRAND_COOKIE}=; Max-Age=0`
      : `${BRAND_COOKIE}=${raw}; Max-Age=${BRAND_COOKIE_MAX_AGE}`;
  return `${value}; Path=/; SameSite=Lax${secure ? "; Secure" : ""}`;
}
