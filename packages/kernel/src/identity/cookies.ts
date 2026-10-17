import type { FastifyReply } from "fastify";
import type { KernelConfig } from "../config/schema.js";
import type { IssuedSession } from "./sessions.js";

/** access token Cookie：随所有请求发送。 */
export const ACCESS_COOKIE = "cap_at";
/** refresh token Cookie：只发往认证端点。 */
export const REFRESH_COOKIE = "cap_rt";
/** refresh Cookie 的 Path。 */
export const REFRESH_COOKIE_PATH = "/api/v1/auth";

/**
 * 写会话 Cookie。两个 Cookie 都 HttpOnly、都**不设 Domain**（只属于当前主机）；
 * `cap_at` 为 SameSite=Lax、Path=/；`cap_rt` 为 SameSite=Strict、只发往 `/api/v1/auth`。
 */
export function setSessionCookies(reply: FastifyReply, s: IssuedSession, cfg: KernelConfig): void {
  const secure = cfg.auth.cookieSecure;
  reply.setCookie(ACCESS_COOKIE, s.accessToken, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure,
    maxAge: cfg.auth.accessTokenTtlSeconds,
  });
  reply.setCookie(REFRESH_COOKIE, s.refreshToken, {
    path: REFRESH_COOKIE_PATH,
    httpOnly: true,
    sameSite: "strict",
    secure,
    maxAge: cfg.auth.refreshTokenTtlDays * 86400,
  });
}

/** 清除会话 Cookie（Path 必须与设置时一致才能覆盖）。 */
export function clearSessionCookies(reply: FastifyReply): void {
  reply.clearCookie(ACCESS_COOKIE, { path: "/" });
  reply.clearCookie(REFRESH_COOKIE, { path: REFRESH_COOKIE_PATH });
}
