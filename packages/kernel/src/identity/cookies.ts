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
/** The Path earlier releases set `cap_rt` on; browsers may still hold it, so it is cleared too. */
export const LEGACY_REFRESH_COOKIE_PATH = "/api/v1/auth";

/**
 * Writes the session cookies. Both are HttpOnly, host-only (no Domain), SameSite=Lax and Path=/;
 * the `cap_rt` on the legacy Path is cleared at the same time.
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
    sameSite: "lax",
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
