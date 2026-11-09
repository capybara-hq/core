import { type NextRequest, NextResponse } from "next/server";
import { isAppLocale, LOCALE_COOKIE } from "./i18n/routing";
import { loginPathFor } from "./lib/auth-sources";
import { credentialQueryRedirect, handleFormPost, isNativeFormPost } from "./lib/form-post";
import {
  CSP_HEADER,
  documentPolicy,
  NONCE_HEADER,
  newNonce,
  PATH_HEADER,
  SESSION_STATE_HEADER,
} from "./lib/headers";
import { trustedPeer } from "./lib/peer";
import { isPublicPath } from "./lib/routes";
import { ACCESS_COOKIE, serverNeedsSetup } from "./lib/server-setup";
import { accessTokenExpiresSoon, renewSession, setCookieValue } from "./lib/session-renewal";

/** The kernel's refresh-token cookie (`cap_rt`, Path=/, SameSite=Lax). */
const REFRESH_COOKIE = "cap_rt";
/** Marks a request redirected once after losing a refresh race to another web replica. */
const RETRY_COOKIE = "cap_retry";
const RETRY_SET = `${RETRY_COOKIE}=1; Path=/; Max-Age=10; HttpOnly; SameSite=Lax`;
const RETRY_CLEAR = `${RETRY_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;
const SESSION_CLEARS = [
  `${ACCESS_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`,
  `${REFRESH_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`,
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

/**
 * A bodiless 303 of `lib/form-post.ts` as the proxy's NextResponse; its relative Location is
 * resolved against the request (Next's proxy adapter only takes an absolute one).
 */
function asNext(req: NextRequest, res: Response): NextResponse {
  const headers = new Headers(res.headers);
  const location = headers.get("location");
  if (location !== null) headers.set("location", new URL(location, req.nextUrl).toString());
  return new NextResponse(null, { status: res.status, headers });
}

function withCookies(res: NextResponse, setCookies: readonly string[]): NextResponse {
  for (const c of setCookies) res.headers.append("set-cookie", c);
  return res;
}

/**
 * Next's Proxy (formerly Middleware), for every page request (spec 2026-11-01-web-ssr §2.1):
 * 1. an old link with a language prefix redirects to the same path without it, keeping the language
 *    in the `NEXT_LOCALE` cookie;
 * 2. a request with `cap_rt` and without `cap_at` (or with one whose token expires within 30 s)
 *    renews the session at the kernel, and the new cookies go both ways (the forwarded request and
 *    the response);
 * 3. a protected page still without `cap_at` redirects to `/setup` (fresh deployment) or sign-in;
 * 4. the forwarded request carries `x-cap-path` (path + query), and `x-cap-session: unavailable`
 *    when the kernel could not be reached;
 * 5. the document CSP (client extensions spec §9.5, {@link documentPolicy}) with a fresh nonce goes
 *    on the forwarded request (Next takes the nonce from it and puts it on its own scripts; the
 *    layouts read `x-nonce`) and on the response. A client-sent nonce or policy never survives.
 * Before all that, a native form POST (the client JS did not load) is answered by
 * `lib/form-post.ts` (sign-in and setup run server side, other pages get a 303 back), and a GET of
 * a credential page with form fields in its query is redirected to the page without them.
 * `/api/*`, `/plugin-ui/*`, `/_next/*`, `/dev/ui/*` and `/icon.svg` never come here (`config`).
 */
export default async function proxy(req: NextRequest): Promise<NextResponse> {
  const legacy = localeRedirect(req);
  if (legacy !== undefined) return legacy;

  const { pathname, search } = req.nextUrl;
  if (isNativeFormPost(req)) return asNext(req, await handleFormPost(req, pathname, search));
  if (req.method === "GET") {
    const scrubbed = credentialQueryRedirect(pathname, search);
    if (scrubbed !== undefined) return asNext(req, scrubbed);
  }
  const headers = new Headers(req.headers);
  headers.delete(SESSION_STATE_HEADER);
  headers.set(PATH_HEADER, `${pathname}${search}`);
  const nonce = newNonce();
  const policy = documentPolicy({
    nonce,
    // the host the browser addressed (lib/form-post.ts's same-origin check trusts it too)
    host: req.headers.get("host") ?? req.nextUrl.host,
    dev: process.env.NODE_ENV !== "production",
  });
  headers.set(CSP_HEADER, policy);
  // Next falls back to the report-only header for the nonce: never let a client supply one
  headers.delete(`${CSP_HEADER}-report-only`);
  headers.set(NONCE_HEADER, nonce);

  const pairs = parseCookies(req.headers.get("cookie"));
  const hasRetry = pairs.some(([n]) => n === RETRY_COOKIE);
  const accessToken = cookieValue(pairs, ACCESS_COOKIE);
  let signedIn = accessToken !== undefined;
  let unavailable = false;
  const setCookies: string[] = [];
  const refreshToken = cookieValue(pairs, REFRESH_COOKIE);
  // Renew without cap_at, and also when cap_at outlived its token or is about to expire.
  const renew =
    refreshToken !== undefined &&
    (accessToken === undefined || accessTokenExpiresSoon(accessToken, Date.now()));

  if (!renew) {
    if (signedIn && hasRetry) setCookies.push(RETRY_CLEAR);
  } else {
    const renewal = await renewSession(refreshToken, {
      peer: trustedPeer(req.headers),
      userAgent: req.headers.get("user-agent") ?? undefined,
    });
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
        // With the marker: give up, keeping an expiring cap_at if there is one.
        if (!hasRetry) return withCookies(NextResponse.redirect(req.nextUrl, 307), [RETRY_SET]);
        break;
      case "invalid": {
        const rest = withSession(pairs, []);
        if (rest === "") headers.delete("cookie");
        else headers.set("cookie", rest);
        // the kernel's clears carry its Secure attribute and the legacy-path cap_rt; ours are a fallback
        setCookies.push(...(renewal.setCookies.length > 0 ? renewal.setCookies : SESSION_CLEARS));
        signedIn = false;
        break;
      }
      case "unavailable":
        // An expiring cap_at still carries the request; without one the page renders "unavailable".
        if (!signedIn) {
          headers.set(SESSION_STATE_HEADER, "unavailable");
          unavailable = true;
        }
        break;
    }
  }

  // The sign-in gate: an optimistic cookie check; server components still verify the session.
  if (!signedIn && !unavailable && !isPublicPath(pathname)) {
    const to =
      (await serverNeedsSetup()) === true ? "/setup" : loginPathFor(`${pathname}${search}`);
    return withCookies(NextResponse.redirect(new URL(to, req.nextUrl), 307), setCookies);
  }

  const res = NextResponse.next({ request: { headers } });
  res.headers.set(CSP_HEADER, policy);
  return withCookies(res, setCookies);
}

export const config = {
  // Every document. Skipped are only routes that are never an app page: /api and /plugin-ui (route
  // handlers), /_next, the design catalog /dev/ui and the metadata icon /icon.svg. Any other path,
  // dotted or not (`/chat/x.y`, `/dev/x`, `/a/b.png`), can land in the (app) layout through a
  // dynamic segment or `[...rest]`, so it must get the CSP and a nonce the client cannot choose.
  matcher: ["/((?!api(?:/|$)|plugin-ui(?:/|$)|_next(?:/|$)|dev/ui(?:/|$)|icon\\.svg$).*)"],
};
