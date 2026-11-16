import type { FastifyReply } from "fastify";
import type { KernelConfig } from "../config/schema.js";
import type { IssuedSession } from "./sessions.js";

/** access token Cookie：随所有请求发送。 */
export const ACCESS_COOKIE = "cap_at";
/**
 * The refresh-token cookie: SameSite=Lax so a top-level navigation from another site (an IM card
 * link, an email, an OAuth return) carries it and the web tier can renew the session. The refresh
 * endpoint is POST-only and requires `X-Capybara-Csrf`, and Lax cookies are not sent on cross-site
 * POSTs, so this does not widen CSRF exposure.
 */
export const REFRESH_COOKIE = "cap_rt";
/**
 * Path of the refresh Cookie: `/`, so the web tier sees it on page requests and can renew the
 * session while rendering on the server.
 */
export const REFRESH_COOKIE_PATH = "/";
/**
 * The Path earlier builds set `cap_rt` on. Cleared (never read) with every session write, so a
 * browser that still holds it stops sending a stale token. Remove after 2026-12-01.
 */
export const OLD_REFRESH_COOKIE_PATH = "/api/v1/auth";
/** Writes the session cookies. Both are HttpOnly, host-only (no Domain), SameSite=Lax and Path=/. */
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
    sameSite: "lax",
    secure,
    maxAge: cfg.auth.refreshTokenTtlDays * 86400,
  });
  // clears stale client state from earlier builds; remove after 2026-12-01
  reply.clearCookie(REFRESH_COOKIE, { path: OLD_REFRESH_COOKIE_PATH });
}

/** 清除会话 Cookie（Path 必须与设置时一致才能覆盖）。 */
export function clearSessionCookies(reply: FastifyReply): void {
  reply.clearCookie(ACCESS_COOKIE, { path: "/" });
  reply.clearCookie(REFRESH_COOKIE, { path: REFRESH_COOKIE_PATH });
  // clears stale client state from earlier builds; remove after 2026-12-01
  reply.clearCookie(REFRESH_COOKIE, { path: OLD_REFRESH_COOKIE_PATH });
}

/**
 * The startup warning for an http trial that cannot sign in: session cookies are Secure but the
 * configured public URL is plain http, so browsers drop them. Null when cookies are not Secure,
 * or the public URL is https or unset (an unset URL says nothing about how people reach the app).
 */
export function insecurePublicUrlWarning(cfg: KernelConfig): string | null {
  const url = cfg.http.publicUrl;
  if (!cfg.auth.cookieSecure || url === undefined || !url.startsWith("http://")) return null;
  const host = new URL(url).hostname;
  if (host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1") return null;
  return `http.publicUrl is ${url} (plain http) while auth.cookieSecure is true: browsers drop the Secure session cookies, so sign-in will not stick. Serve the app over HTTPS, or for a short http trial set auth.cookieSecure=false (CAPYBARA_AUTH__COOKIE_SECURE=false; CAPYBARA_COOKIE_SECURE=false in the compose .env)`;
}
