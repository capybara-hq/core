import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ServerClock } from "@capybara-hq/design";
import type { DehydratedState, QueryClient } from "@tanstack/react-query";
import { act } from "@testing-library/react";
import type { ReactNode } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { vi } from "vitest";
import { HydrateCache } from "../../src/components/HydrateCache";
import type { OrgReadiness } from "../../src/lib/agents";
import { setApiTransport } from "../../src/lib/api";
import { makeQueryClient } from "../../src/lib/query/client";
import { matchRoute } from "../../src/lib/query/routes";
import { meQuery, readinessQuery } from "../../src/lib/query/shell";
import { dehydrateFor, prefetchRoute } from "../../src/lib/server/query";
import { type Call, stubApi } from "./api";
import { ME, pageElement, renderPage, testQueryClient } from "./render";

export { testQueryClient };

import { type Routes, serverRoutes, sessionRoutes } from "./server";

type RouteOpts = Parameters<typeof renderPage>[1] & { readiness?: OrgReadiness };

const APP = join(import.meta.dirname, "../../src/app");

/**
 * What `page.tsx` of `path` returns, as Next calls it (params and search params as promises). The
 * page is found by the route table's pattern under `(app)` or `(auth)`.
 */
async function pageOf(path: string): Promise<ReactNode> {
  const match = matchRoute(path);
  if (match === null) throw new Error(`no route serves ${path}`);
  const dir = match.entry.pattern === "/" ? "" : match.entry.pattern;
  const file = ["(app)", "(auth)"]
    .map((group) => join(APP, group, dir, "page.tsx"))
    .find((f) => existsSync(f));
  if (file === undefined) throw new Error(`no page.tsx for ${match.entry.pattern}`);
  const { default: Page } = (await import(/* @vite-ignore */ file)) as {
    default: (props: unknown) => ReactNode | Promise<ReactNode>;
  };
  return Page({
    params: Promise.resolve(match.params),
    searchParams: Promise.resolve(Object.fromEntries(match.search)),
  });
}

/** `page` inside the layout's `HydrationBoundary` holding `state`. */
function withCache(page: ReactNode, state?: DehydratedState) {
  return state === undefined ? page : <HydrateCache state={state}>{page}</HydrateCache>;
}

/**
 * A document load of `path`: the layout's prefetch (`/me` and readiness, then the route's queries)
 * and the page
 * run against `routes` (plus the gate's `sessionRoutes`) on the server; the cache is dehydrated
 * (through JSON, as it crosses to the browser) and the page renders inside `HydrationBoundary`.
 * Install the browser's routes (`stubApi`, `expectNoFirstPaintFetch`) first. Returns the server
 * calls and the browser's client.
 */
/** The server half of a document load: the layout's and the route's prefetch, and the page. */
async function serverLoad(path: string, routes: Routes, opts: RouteOpts) {
  const { readiness, ...render } = opts;
  const me = render.me ?? ME;
  const calls = serverRoutes({ ...sessionRoutes(me, readiness), ...routes });
  let state: DehydratedState;
  let page: ReactNode;
  try {
    const qc = makeQueryClient();
    await qc.fetchQuery(meQuery());
    // The shell's readiness (the layout's `getShell()` reads it beside the route).
    if (me.currentOrgId !== null) await qc.fetchQuery(readinessQuery(me.currentOrgId));
    await prefetchRoute(qc, path, { me, orgId: me.currentOrgId, locale: render.locale ?? "en" });
    page = await pageOf(path);
    state = JSON.parse(JSON.stringify(dehydrateFor(qc))) as DehydratedState;
  } finally {
    setApiTransport(null);
  }
  return { calls, state, page, render };
}

export async function renderRouteWithCache(path: string, routes: Routes, opts: RouteOpts = {}) {
  const { calls, state, page, render } = await serverLoad(path, routes, opts);
  const client = testQueryClient();
  const view = renderPage(withCache(page, state), { ...render, client });
  /**
   * A client navigation to `to` under the same layout: the page of `to` replaces this one inside
   * the same `HydrationBoundary` (the layout does not run again), with the same browser cache.
   * Its browser reads go through `stubApi` (install the routes first).
   */
  const navigate = async (to: string) => {
    const next = await pageOf(to);
    view.rerender(pageElement(withCache(next, state), render));
  };
  return { calls, client, navigate, ...view };
}

/**
 * A document load of a public (auth) page: the (auth) layout's prefetch of the route's queries (no
 * shell, no session read of its own, no redirect when signed out) and the page run against
 * `routes` on the server, then the page renders inside `HydrationBoundary` as
 * {@link renderRouteWithCache} does. The segment layouts (`login/layout`, `bind/[token]/layout`)
 * are not run: their redirects have their own tests. Returns the server calls and the client.
 */
export async function renderAuthRouteWithCache(
  path: string,
  routes: Routes,
  opts: Parameters<typeof renderPage>[1] = {},
) {
  const calls = serverRoutes(routes);
  let state: DehydratedState;
  let page: ReactNode;
  try {
    const qc = makeQueryClient();
    await prefetchRoute(qc, path, { me: null, orgId: null }, { signedOutRedirect: false });
    page = await pageOf(path);
    state = JSON.parse(JSON.stringify(dehydrateFor(qc))) as DehydratedState;
  } finally {
    setApiTransport(null);
  }
  const client = opts.client ?? testQueryClient();
  return { calls, client, ...renderPage(withCache(page, state), { ...opts, client }) };
}

/**
 * A client navigation to `path` with nothing cached: the page renders against an empty browser
 * cache and its views read through `stubApi(routes)` (plus `sessionRoutes`). A page not migrated
 * yet still reads on the server; those reads are served from the same routes. `opts.client` is a
 * browser cache the test seeded. Returns the browser calls and the client.
 */
export async function renderRouteEmptyCache(
  path: string,
  routes: Routes,
  opts: RouteOpts = {},
): Promise<{ calls: Call[]; client: QueryClient } & ReturnType<typeof renderPage>> {
  const { readiness, ...render } = opts;
  const all = { ...sessionRoutes(render.me ?? ME, readiness), ...routes };
  let page: ReactNode;
  serverRoutes(all);
  try {
    page = await pageOf(path);
  } finally {
    setApiTransport(null);
  }
  const calls = stubApi(all);
  // A client the test seeded (what an earlier navigation left in the cache), or a fresh one.
  const client = render.client ?? testQueryClient();
  return { calls, client, ...renderPage(withCache(page), { ...render, client }) };
}

/**
 * A document load of `path` as the browser gets it: the server renders the page to HTML (with
 * `clock`, the root layout's {@link ServerClock}; none: the old behavior, each side its own), then, once `beforeHydrate` has run (to move the
 * browser's clock), the browser hydrates that HTML with the dehydrated cache. Returns the
 * container and the hydration errors React reported (`onRecoverableError`, and hydration
 * `console.error`s such as attribute mismatches), so a test can assert there were none.
 */
export async function hydrateRouteWithCache(
  path: string,
  routes: Routes,
  opts: RouteOpts & { clock?: ServerClock; beforeHydrate?: () => void },
) {
  const { clock, beforeHydrate, ...rest } = opts;
  const { state, page, render } = await serverLoad(path, routes, rest);
  const html = renderToString(
    pageElement(withCache(page, state), {
      ...render,
      client: testQueryClient(),
      ...(clock !== undefined && { clock }),
    }),
  );
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.append(container);
  beforeHydrate?.();
  const errors: string[] = [];
  const consoleError = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    const text = args.map(String).join(" ");
    if (/hydrat|didn't match/i.test(text)) errors.push(text);
  });
  const client = testQueryClient();
  let root: Root | undefined;
  try {
    await act(async () => {
      root = hydrateRoot(
        container,
        pageElement(withCache(page, state), {
          ...render,
          client,
          ...(clock !== undefined && { clock }),
        }),
        { onRecoverableError: (e) => errors.push(String(e)) },
      );
    });
  } finally {
    consoleError.mockRestore();
  }
  const unmount = () => {
    act(() => root?.unmount());
    container.remove();
  };
  return { container, errors, html, client, unmount };
}
