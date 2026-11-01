import type { ReactNode } from "react";
import { onTestFinished } from "vitest";
import type { OrgReadiness } from "../../src/lib/agents";
import { setApiTransport } from "../../src/lib/api";
import type { Me } from "../../src/lib/session";
import { type Call, json, stubApi } from "./api";
import { router } from "./navigation";
import { ME, pageElement, renderPage } from "./render";

type Routes = Record<string, (call: Call) => Response | Promise<Response>>;

/**
 * The server phase of a page test: installs a stub transport for the page's `apiFetch` reads
 * (routes as in {@link stubApi}: `METHOD path`, with or without the query) and returns the calls.
 * Removed when the test finishes, or by {@link renderServer}.
 */
export function serverRoutes(routes: Routes): Call[] {
  const calls: Call[] = [];
  setApiTransport(
    async (path, init) => {
      const method = (init.method ?? "GET").toUpperCase();
      const call = { url: path, method, body: init.body, headers: new Headers(init.headers) };
      calls.push(call);
      const handler = routes[`${method} ${path}`] ?? routes[`${method} ${path.split("?")[0]}`];
      if (!handler) throw new Error(`unexpected server ${method} ${path}`);
      return handler(call);
    },
    { everywhere: true },
  );
  onTestFinished(() => setApiTransport(null));
  return calls;
}

/**
 * Renders what a server page returned (`renderServer(await Page(props))`) inside the providers of
 * `renderPage`. The server phase ends first: client components then fetch through `fetch` again.
 */
export function renderServer(element: ReactNode, opts?: Parameters<typeof renderPage>[1]) {
  setApiTransport(null);
  return renderPage(element, opts);
}

/**
 * Any browser fetch throws: the first paint must come from the server's data. Returns the calls
 * (assert they stay empty: a client view may swallow the failure into an error state).
 */
export function expectNoFirstPaintFetch(): Call[] {
  return stubApi({});
}

/**
 * The reads every workspace page's gate makes (`workspace()`): `/me` for `me` and its current org's
 * readiness (ready unless given).
 */
export function sessionRoutes(
  me: Me = ME,
  readiness: OrgReadiness = { modelProvider: "ready", agents: 1 },
): Routes {
  return {
    "GET /api/v1/me": () => json(200, me),
    ...(me.currentOrgId !== null
      ? { [`GET /api/v1/orgs/${me.currentOrgId}/readiness`]: () => json(200, readiness) }
      : {}),
  };
}

/**
 * A server page test in one call: the page's reads are served from `routes` (plus the gate's
 * {@link sessionRoutes}), then what it returned is rendered. Install the browser's routes
 * (`stubApi`, or {@link expectNoFirstPaintFetch}) before calling it; the server calls are returned.
 *
 * `refresh()` stands for `router.refresh()`: the page runs again on the server with the same
 * routes (which may answer differently by now), its output replaces the rendered one and its calls
 * join `calls`. The mocked `router.refresh` (`support/navigation`) does that by itself.
 */
export async function renderRoute(
  page: () => Promise<ReactNode>,
  routes: Routes,
  opts: Parameters<typeof renderPage>[1] & { readiness?: OrgReadiness } = {},
) {
  const { readiness, ...render } = opts;
  const all = { ...sessionRoutes(render.me, readiness), ...routes };
  const calls = serverRoutes(all);
  const element = await page();
  const view = renderServer(element, render);
  const refresh = async () => {
    const more = serverRoutes(all);
    let next: ReactNode;
    try {
      next = await page();
    } finally {
      setApiTransport(null);
      calls.push(...more);
    }
    view.rerender(pageElement(next, render));
  };
  router.refresh.mockImplementation(() => void refresh());
  return { calls, refresh, ...view };
}
