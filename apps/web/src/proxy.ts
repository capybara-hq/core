import { type NextRequest, NextResponse } from "next/server";
import { isAppLocale, LOCALE_COOKIE } from "./i18n/routing";

/**
 * Next's Proxy (formerly Middleware). URLs carry no language since the language moved to the
 * `NEXT_LOCALE` cookie; an old link with a language prefix (`/zh/agents`, `/en`) still works: it
 * redirects to the same path without the prefix and keeps that language in the cookie.
 * `/api/*` and `/plugin-ui/*` never come here (their routes proxy to the kernel).
 */
export default function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  const m = /^\/([^/]+)(\/.*)?$/.exec(pathname);
  const prefix = m?.[1];
  if (!isAppLocale(prefix)) return NextResponse.next();
  const url = req.nextUrl.clone();
  url.pathname = m?.[2] ?? "/";
  url.search = search;
  const res = NextResponse.redirect(url, 308);
  res.cookies.set(LOCALE_COOKIE, prefix, { path: "/", maxAge: 31536000, sameSite: "lax" });
  return res;
}

export const config = {
  // Only paths that start with a language: /zh, /en and anything below them.
  matcher: ["/zh", "/zh/:path*", "/en", "/en/:path*"],
};
