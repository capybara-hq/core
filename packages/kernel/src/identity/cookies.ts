import type { FastifyReply } from "fastify";
import type { KernelConfig } from "../config/schema.js";
import type { IssuedSession } from "./sessions.js";

/** access token Cookie：随所有请求发送。 */
export const ACCESS_COOKIE = "cap_at";
/** refresh token Cookie：只发往认证端点。 */
export const REFRESH_COOKIE = "cap_rt";
/**
 * Path of the refresh Cookie: `/`, so the web tier sees it on page requests and can renew the
 * session while rendering on the server.
 */
export const REFRESH_COOKIE_PATH = "/";
/** The Path earlier releases set `cap_rt` on; browsers may still hold it, so it is cleared too. */
export const LEGACY_REFRESH_COOKIE_PATH = "/api/v1/auth";

/**
 * 写会话 Cookie。两个 Cookie 都 HttpOnly、都**不设 Domain**（只属于当前主机）；
 * `cap_at` 为 SameSite=Lax、Path=/；`cap_rt` 为 SameSite=Strict、Path=/；同时清掉旧 Path 上的 `cap_rt`。
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
  reply.clearCookie(REFRESH_COOKIE, { path: LEGACY_REFRESH_COOKIE_PATH });
}

/** 清除会话 Cookie（Path 必须与设置时一致才能覆盖）。 */
export function clearSessionCookies(reply: FastifyReply): void {
  reply.clearCookie(ACCESS_COOKIE, { path: "/" });
  reply.clearCookie(REFRESH_COOKIE, { path: REFRESH_COOKIE_PATH });
  reply.clearCookie(REFRESH_COOKIE, { path: LEGACY_REFRESH_COOKIE_PATH });
}

/**
 * Every `cap_rt` value of a raw `cookie` header, in header order. A browser holding the legacy
 * Path cookie and the new one sends both, the more specific Path first.
 */
export function refreshCookieValues(header: string | undefined): string[] {
  if (!header) return [];
  const out: string[] = [];
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0 || part.slice(0, eq).trim() !== REFRESH_COOKIE) continue;
    let v = part.slice(eq + 1).trim();
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1);
    try {
      v = decodeURIComponent(v);
    } catch {
      // keep the raw value
    }
    if (v) out.push(v);
  }
  return out;
}
