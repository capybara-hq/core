"use client";

import { useDesignLocale } from "@capybara-hq/design";
import { type QueryClient, QueryClientContext } from "@tanstack/react-query";
import { useCallback, useContext, useEffect, useRef } from "react";
import { useRouter } from "../../i18n/navigation";
import type { Me } from "../session";
import { uiLocale } from "../ui";
import { matchRoute, type RouteCtx, UNKNOWN_ROUTE } from "./routes";
import { meQuery } from "./shell";

/** What `warmRoute` needs of the router (`router.prefetch`). */
export type Prefetcher = { prefetch(href: string): void };

/**
 * Warms a route the viewer is about to open (mobile spec §7.3): runs the route table's first-paint
 * queries into the cache (`prefetchQuery`, so fresh data is not read again; a failure stays quiet)
 * and asks Next to prefetch the route's code. Does nothing for another origin or a path no page
 * serves; an entry gates its own queries by role, so nothing the viewer may not open is read.
 */
export async function warmRoute(
  qc: QueryClient,
  href: string,
  ctx: RouteCtx,
  router?: Prefetcher,
): Promise<void> {
  const path = sameOriginPath(href);
  if (path === null) return;
  const match = matchRoute(path);
  if (match === null || match.entry.pattern === UNKNOWN_ROUTE) return;
  router?.prefetch(path);
  const queries = match.entry.queries({ ...ctx, params: match.params, search: match.search });
  await Promise.all(queries.map((q) => qc.prefetchQuery({ ...q, retry: false }).catch(() => {})));
}

/** The path (with its query) of a same-origin `href`, `null` for anything else. */
function sameOriginPath(href: string): string | null {
  if (href.startsWith("//")) return null;
  if (href.startsWith("/")) return href;
  if (typeof window === "undefined") return null;
  try {
    const url = new URL(href, window.location.href);
    return url.origin === window.location.origin ? url.pathname + url.search : null;
  } catch {
    return null;
  }
}

/** The route context of the browser now, from the cached `/me` (none yet: nothing is warmed). */
function ctxOf(qc: QueryClient, locale: string): RouteCtx | null {
  const me = qc.getQueryData<Me>(meQuery().queryKey);
  if (me === undefined) return null;
  return {
    params: {},
    search: new URLSearchParams(),
    me,
    orgId: me.memberships.find((m) => m.orgId === me.currentOrgId)?.orgId ?? null,
    locale: uiLocale(locale),
    cookie: () => undefined,
    now: Date.now(),
  };
}

/**
 * A function that warms `href` with the browser's cache and session; a no-op without a query
 * client (pages outside the app's provider) or before `/me` is cached.
 */
export function useWarm(router?: Prefetcher): (href: string) => void {
  const qc = useContext(QueryClientContext);
  const locale = useDesignLocale();
  const routerRef = useRef(router);
  routerRef.current = router;
  return useCallback(
    (href: string) => {
      if (qc === undefined) return;
      const ctx = ctxOf(qc, locale);
      if (ctx !== null) void warmRoute(qc, href, ctx, routerRef.current);
    },
    [qc, locale],
  );
}

/**
 * Warms each conversation row (the `[data-part="conversation"]` links in the document) once, the
 * first time it scrolls into view. `rows` changes when rows may have been added.
 */
export function useWarmRowsInView(scope: string, rows: unknown): void {
  const router = useRouter();
  const warm = useWarm(router);
  const warmRef = useRef(warm);
  warmRef.current = warm;
  const done = useRef({ scope, hrefs: new Set<string>() });
  if (done.current.scope !== scope) done.current = { scope, hrefs: new Set() };
  // biome-ignore lint/correctness/useExhaustiveDependencies: `rows` re-scans the document
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const seen = done.current.hrefs;
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const href = (e.target as HTMLElement).getAttribute("href");
        io.unobserve(e.target);
        if (href === null || seen.has(href)) continue;
        seen.add(href);
        warmRef.current(href);
      }
    });
    for (const el of document.querySelectorAll('[data-part="conversation"][href^="/chat/"]')) {
      const href = el.getAttribute("href");
      if (href !== null && !seen.has(href)) io.observe(el);
    }
    return () => io.disconnect();
  }, [scope, rows]);
}
