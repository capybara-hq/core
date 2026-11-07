import { apiFetch } from "./api";
import { HOME_PATH } from "./routes";

/** 第三方登录的身份源（`GET /api/v1/auth/sources`）。 */
export interface AuthSource {
  plugin: string;
  label: { zh: string; en: string };
}

export const listAuthSources = () => apiFetch<{ sources: AuthSource[] }>("/api/v1/auth/sources");

/**
 * 第三方登录回跳登录页时带的原因码（`/login?error=<code>`）。界面只显示自己的译文，
 * 不在集合里的按 `unknown` 处理。
 */
export const LOGIN_ERROR_CODES = [
  "sso.unavailable",
  "sso.state_invalid",
  "sso.session_mismatch",
  "sso.access_denied",
  "sso.provider_error",
  "sso.identity_not_verified",
  "auth.account_disabled",
] as const;
export type LoginErrorCode = (typeof LOGIN_ERROR_CODES)[number] | "unknown";

/** 读取登录页地址里的 `error` 原因码；没有时为 null。 */
export function parseLoginError(search: string): LoginErrorCode | null {
  const code = new URLSearchParams(search).get("error");
  if (code === null) return null;
  return (LOGIN_ERROR_CODES as readonly string[]).includes(code)
    ? (code as LoginErrorCode)
    : "unknown";
}

/**
 * The site path to return to after signing in (`?returnTo=`): only a same-origin path starting with
 * a single `/`, without backslashes or control characters; anything else (or nothing) goes home
 * ({@link HOME_PATH}, so a lure cannot send the visitor off-site). The rules match the kernel's
 * `isSafeReturnPath`.
 */
export function safeReturnTo(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return HOME_PATH;
  if (raw.length > 500 || !raw.startsWith("/") || raw.startsWith("//")) return HOME_PATH;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it rejects
  if (/[\\\u0000-\u001f\u007f]/.test(raw)) return HOME_PATH;
  try {
    const base = "https://return.invalid";
    return new URL(raw, base).origin === base ? raw : HOME_PATH;
  } catch {
    return HOME_PATH;
  }
}

/** 发起第三方登录的地址（整页跳转；内核 302 到身份源，回调后回到 `returnTo`）。 */
export const ssoStartUrl = (plugin: string, returnTo: string) =>
  `/api/v1/auth/sso/${encodeURIComponent(plugin)}/start?returnTo=${encodeURIComponent(returnTo)}`;

/**
 * The sign-in page's path with its return path (no language prefix; next-intl's navigation adds
 * it). Home (or `/`, which redirects there) needs no `returnTo`: sign-in goes home by default.
 */
export const loginPathFor = (returnTo: string) =>
  returnTo === "/" || returnTo === HOME_PATH
    ? "/login"
    : `/login?returnTo=${encodeURIComponent(returnTo)}`;

/**
 * Where the sign-in page at `path` (path and query) sends a visitor who is already signed in: its
 * `returnTo` (one value, a safe site path), unless that is a sign-in page itself (a loop).
 */
export function signedInTarget(path: string): string {
  const q = path.indexOf("?");
  const values = new URLSearchParams(q === -1 ? "" : path.slice(q + 1)).getAll("returnTo");
  const returnTo = safeReturnTo(values.length === 1 ? values[0] : undefined);
  const target = returnTo.split(/[?#]/)[0] ?? HOME_PATH;
  return target === "/login" || target === "/setup" ? HOME_PATH : returnTo;
}
