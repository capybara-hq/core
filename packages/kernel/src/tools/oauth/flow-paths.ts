import { ApiError } from "../../errors.js";

// The OAuth connect flow's paths and URL rules: a leaf module (no service imports), so the
// connectors service can use them without an import cycle through the flow.

/** 授权回调的路径（`http.publicUrl` + 它 = 注册给授权服务器的 redirect_uri）。 */
export const OAUTH_CALLBACK_PATH = "/api/v1/oauth/callback";
/** state 的有效期（秒）。 */
export const OAUTH_STATE_TTL_SECONDS = 600;
/** 浏览器绑定 Cookie：回调必须来自发起连接的同一个浏览器。 */
export const OAUTH_BINDING_COOKIE = "cap_oauth";
/** 回调失败、或连接时没给回跳页面时回到的网页（next-intl 会补语言前缀）。 */
export const DEFAULT_RETURN_PATH = "/settings/connections";

/** OAuth 连接器需要 `http.publicUrl`（回调地址）；未配置 → 这条校验错误。 */
export const publicUrlRequired = () =>
  new ApiError("validation_failed", "Request validation failed", [
    {
      path: "auth",
      message:
        "OAuth connectors require http.publicUrl to be configured (it is used to build the OAuth callback URL)",
    },
  ]);

export function callbackUrl(publicUrl: string): string {
  return `${publicUrl.replace(/\/+$/, "")}${OAUTH_CALLBACK_PATH}`;
}

/**
 * 回跳页面只接受站内相对路径（防开放重定向）：以单个 `/` 开头，不含 `\` 与控制字符，解析后仍在同一个源。
 */
export function isSafeReturnPath(p: string): boolean {
  if (p.length > 500 || !p.startsWith("/") || p.startsWith("//")) return false;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 正是要拒绝控制字符
  if (/[\\\u0000-\u001f\u007f]/.test(p)) return false;
  const base = "https://return.invalid";
  try {
    return new URL(p, base).origin === base;
  } catch {
    return false;
  }
}
