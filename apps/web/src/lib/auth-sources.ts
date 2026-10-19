import { apiFetch } from "./api";

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
 * 登录后回到的站内路径（`?returnTo=`）：只接受以单个 `/` 开头、同源、无反斜杠与控制字符的路径，
 * 否则回首页（防止被诱导跳到外站）。规则与内核的 `isSafeReturnPath` 一致。
 */
export function safeReturnTo(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return "/";
  if (raw.length > 500 || !raw.startsWith("/") || raw.startsWith("//")) return "/";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 正是要拒绝控制字符
  if (/[\\\u0000-\u001f\u007f]/.test(raw)) return "/";
  try {
    const base = "https://return.invalid";
    return new URL(raw, base).origin === base ? raw : "/";
  } catch {
    return "/";
  }
}

/** 发起第三方登录的地址（整页跳转；内核 302 到身份源，回调后回到 `returnTo`）。 */
export const ssoStartUrl = (plugin: string, returnTo: string) =>
  `/api/v1/auth/sso/${encodeURIComponent(plugin)}/start?returnTo=${encodeURIComponent(returnTo)}`;

/** 带回跳参数的登录页路径（不含语言前缀，交给 next-intl 的导航补上）。 */
export const loginPathFor = (returnTo: string) =>
  returnTo === "/" ? "/login" : `/login?returnTo=${encodeURIComponent(returnTo)}`;
