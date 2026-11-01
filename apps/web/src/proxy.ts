import { type NextRequest, NextResponse } from "next/server";
import { isAppLocale, LOCALE_COOKIE } from "./i18n/routing";
import { loginPathFor } from "./lib/auth-sources";
import { PATH_HEADER, SESSION_STATE_HEADER } from "./lib/headers";
import { trustedPeer } from "./lib/peer";
import { isPublicPath } from "./lib/routes";
import { ACCESS_COOKIE, serverNeedsSetup } from "./lib/server-setup";
import { renewSession, setCookieValue } from "./lib/session-renewal";

/** The kernel's refresh-token cookie (`cap_rt`, Path=/). */
const REFRESH_COOKIE = "cap_rt";
/** Marks a request redirected once after losing a refresh race to another web replica. */
const RETRY_COOKIE = "cap_retry";
const RETRY_SET = `${RETRY_COOKIE}=1; Path=/; Max-Age=10; HttpOnly; SameSite=Lax`;
const RETRY_CLEAR = `${RETRY_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;
const SESSION_CLEARS = [
  `${ACCESS_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`,
  `${REFRESH_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict`,
];

/** The `name=value` pairs of a raw `cookie` header, values as sent. */
function parseCookies(header: string | null): [string, string][] {
  if (header === null) return [];
  const out: [string, string][] = [];
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (name !== "") out.push([name, part.slice(eq + 1).trim()]);
  }
  return out;
}

/** The first non-empty value of a cookie. */
const cookieValue = (pairs: [string, string][], name: string) =>
  pairs.find(([n, v]) => n === name && v !== "")?.[1];

/** The cookie header without the session cookies, plus `extra` ones. */
function withSession(pairs: [string, string][], extra: [string, string][]): string {
  return [...pairs.filter(([n]) => n !== ACCESS_COOKIE && n !== REFRESH_COOKIE), ...extra]
    .map(([n, v]) => `${n}=${v}`)
    .join("; ");
}

/** Old links with a language prefix (`/zh/agents`, `/en`): 308 to the path without it. */
function localeRedirect(req: NextRequest): NextResponse | undefined {
  const { pathname, search } = req.nextUrl;
  const m = /^\/([^/]+)(\/.*)?$/.exec(pathname);
  const prefix = m?.[1];
  if (!isAppLocale(prefix)) return undefined;
  const url = req.nextUrl.clone();
  url.pathname = m?.[2] ?? "/";
  url.search = search;
  const res = NextResponse.redirect(url, 308);
  res.cookies.set(LOCALE_COOKIE, prefix, { path: "/", maxAge: 31536000, sameSite: "lax" });
  return res;
}

function withCookies(res: NextResponse, setCookies: readonly string[]): NextResponse {
  for (const c of setCookies) res.headers.append("set-cookie", c);
  return res;
}

/**
 * Next's Proxy (formerly Middleware), for every page request (spec 2026-11-01-web-ssr §2.1):
 * 1. an old link with a language prefix redirects to the same path without it, keeping the language
 *    in the `NEXT_LOCALE` cookie;
 * 2. a request without `cap_at` but with `cap_rt` renews the session at the kernel, and the new
 *    cookies go both ways (the forwarded request and the response);
 * 3. a protected page still without `cap_at` redirects to `/setup` (fresh deployment) or sign-in;
 * 4. the forwarded request carries `x-cap-path` (path + query), and `x-cap-session: unavailable`
 *    when the kernel could not be reached.
 * `/api/*`, `/plugin-ui/*`, `/_next/*`, `/dev/*` and files never come here.
 */
export default async function proxy(req: NextRequest): Promise<NextResponse> {
  const legacy = localeRedirect(req);
  if (legacy !== undefined) return legacy;

  const { pathname, search } = req.nextUrl;
  const headers = new Headers(req.headers);
  headers.delete(SESSION_STATE_HEADER);
  headers.set(PATH_HEADER, `${pathname}${search}`);

  const pairs = parseCookies(req.headers.get("cookie"));
  const hasRetry = pairs.some(([n]) => n === RETRY_COOKIE);
  let signedIn = cookieValue(pairs, ACCESS_COOKIE) !== undefined;
  let unavailable = false;
  const setCookies: string[] = [];
  const refreshToken = cookieValue(pairs, REFRESH_COOKIE);

  if (signedIn) {
    if (hasRetry) setCookies.push(RETRY_CLEAR);
  } else if (refreshToken !== undefined) {
    const renewal = await renewSession(refreshToken, trustedPeer(req.headers));
    switch (renewal.kind) {
      case "renewed": {
        const rt = setCookieValue(renewal.setCookies, REFRESH_COOKIE) ?? refreshToken;
        headers.set(
          "cookie",
          withSession(pairs, [
            [ACCESS_COOKIE, renewal.accessToken],
            [REFRESH_COOKIE, rt],
          ]),
        );
        setCookies.push(...renewal.setCookies);
        if (hasRetry) setCookies.push(RETRY_CLEAR);
        signedIn = true;
        break;
      }
      case "race":
        // Another web replica rotated the token; the browser holds its cookies by now. Retry once.
        if (!hasRetry) return withCookies(NextResponse.redirect(req.nextUrl, 307), [RETRY_SET]);
        break;
      case "invalid": {
        const rest = withSession(pairs, []);
        if (rest === "") headers.delete("cookie");
        else headers.set("cookie", rest);
        setCookies.push(...SESSION_CLEARS);
        break;
      }
      case "unavailable":
        headers.set(SESSION_STATE_HEADER, "unavailable");
        unavailable = true;
        break;
    }
  }

  // The sign-in gate: an optimistic cookie check; server components still verify the session.
  if (!signedIn && !unavailable && !isPublicPath(pathname)) {
    const to =
      (await serverNeedsSetup()) === true ? "/setup" : loginPathFor(`${pathname}${search}`);
    return withCookies(NextResponse.redirect(new URL(to, req.nextUrl), 307), setCookies);
  }

  return withCookies(NextResponse.next({ request: { headers } }), setCookies);
}

export const config = {
  // Every page: not /api, /plugin-ui, /_next, /dev, nor any path with a dot (files).
  matcher: ["/((?!api(?:/|$)|plugin-ui(?:/|$)|_next(?:/|$)|dev(?:/|$)|.*\\.).*)"],
};
