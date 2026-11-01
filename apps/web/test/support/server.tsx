import type { ReactNode } from "react";
import { onTestFinished } from "vitest";
import { setApiTransport } from "../../src/lib/api";
import { type Call, stubApi } from "./api";
import { renderPage } from "./render";

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
