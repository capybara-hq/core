import { existsSync } from "node:fs";
import { join } from "node:path";
import { type DehydratedState, type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { HydrateCache } from "../../src/components/HydrateCache";
import type { OrgReadiness } from "../../src/lib/agents";
import { setApiTransport } from "../../src/lib/api";
import { makeQueryClient } from "../../src/lib/query/client";
import { matchRoute } from "../../src/lib/query/routes";
import { meQuery } from "../../src/lib/query/shell";
import { dehydrateFor, prefetchRoute } from "../../src/lib/server/query";
import { type Call, stubApi } from "./api";
import { ME, renderPage } from "./render";
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

/** `page` inside a browser query client holding `state`, as the layout's `HydrationBoundary`. */
function withCache(page: ReactNode, client: QueryClient, state?: DehydratedState) {
  return (
    <QueryClientProvider client={client}>
      {state === undefined ? page : <HydrateCache state={state}>{page}</HydrateCache>}
    </QueryClientProvider>
  );
}

/**
 * A document load of `path`: the layout's prefetch (`/me`, then the route's queries) and the page
 * run against `routes` (plus the gate's `sessionRoutes`) on the server; the cache is dehydrated
 * (through JSON, as it crosses to the browser) and the page renders inside `HydrationBoundary`.
 * Install the browser's routes (`stubApi`, `expectNoFirstPaintFetch`) first. Returns the server
 * calls and the browser's client.
 */
export async function renderRouteWithCache(path: string, routes: Routes, opts: RouteOpts = {}) {
  const { readiness, ...render } = opts;
  const me = render.me ?? ME;
  const calls = serverRoutes({ ...sessionRoutes(me, readiness), ...routes });
  let state: DehydratedState;
  let page: ReactNode;
  try {
    const qc = makeQueryClient();
    await qc.fetchQuery(meQuery());
    await prefetchRoute(qc, path, { me, orgId: me.currentOrgId });
    page = await pageOf(path);
    state = JSON.parse(JSON.stringify(dehydrateFor(qc))) as DehydratedState;
  } finally {
    setApiTransport(null);
  }
  const client = makeQueryClient();
  const view = renderPage(withCache(page, client, state), render);
  return { calls, client, ...view };
}

/**
 * A client navigation to `path` with nothing cached: the page renders against an empty browser
 * cache and its views read through `stubApi(routes)` (plus `sessionRoutes`). A page not migrated
 * yet still reads on the server; those reads are served from the same routes. Returns the browser
 * calls and the client.
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
  const client = makeQueryClient();
  return { calls, client, ...renderPage(withCache(page, client), render) };
}
