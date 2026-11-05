import { notFound, redirect } from "next/navigation";
import { getLocale } from "next-intl/server";
import type { ReactNode } from "react";
import pkg from "../../../package.json";
import { HydrateCache } from "../../components/HydrateCache";
import { AppFrame } from "../../components/shell/AppFrame";
import { KernelStarting } from "../../components/shell/KernelStarting";
import { setupReady } from "../../lib/agents";
import { matchRoute } from "../../lib/query/routes";
import { currentPath } from "../../lib/server/page";
import { dehydrateFor, prefetchRoute, serverQueryClient } from "../../lib/server/query";
import { getShell } from "../../lib/server/session";
import { setupRouteOf } from "../../lib/setup-routes";

/**
 * The signed-in pages: the frame (App Shell, setup frame or org chooser) and the session context.
 * On a document request it reads the shell and prefetches the route's queries in one parallel
 * wave (web query cache spec §3.1), and hands both to the browser's cache. Client navigations
 * don't re-render it. The URL has no `(app)`.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const qc = serverQueryClient();
  const path = await currentPath();
  const prefetched: { route: "ok" | "unknown" } = { route: "ok" };
  // The page's locale: an extension view the route prefetches renders in it.
  const locale = await getLocale();
  // Signed out or a fresh deployment never gets here: the proxy (src/proxy.ts) redirects first.
  const shell = await getShell(qc, async (session) => {
    prefetched.route = await prefetchRoute(qc, path, { ...session, locale });
  });
  // The kernel cannot answer (starting, restarting): a frame that retries by itself (ruling R2).
  if (shell.kind === "unavailable") return <KernelStarting />;
  // While the org is not ready, a route that is no setup route goes home before anything streams
  // (web-SSR spec §4). Client navigations don't re-render the layout: `useWorkspace()` covers them.
  const pathname = path.split(/[?#]/)[0] ?? "/";
  if (shell.org !== null && shell.readiness !== null && !setupReady(shell.readiness)) {
    if (setupRouteOf(pathname) === "redirect") redirect("/");
  }
  // No page serves the path. `[...rest]` throws `notFound()` itself, below this layout, so its 404
  // renders inside the App Shell.
  if (prefetched.route === "unknown" && matchRoute(pathname) === null) notFound();
  return (
    <HydrateCache state={dehydrateFor(qc)}>
      <AppFrame version={`v${pkg.version}`}>{children}</AppFrame>
    </HydrateCache>
  );
}
