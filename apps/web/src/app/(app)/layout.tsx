import { notFound, redirect } from "next/navigation";
import { getLocale } from "next-intl/server";
import type { ReactNode } from "react";
import pkg from "../../../package.json";
import { ClientExtensionsHead } from "../../components/client-ext/ClientExtensionsHead";
import { ClientHostRoot } from "../../components/client-ext/ClientHost";
import { HydrateCache } from "../../components/HydrateCache";
import { AppFrame } from "../../components/shell/AppFrame";
import { KernelStarting } from "../../components/shell/KernelStarting";
import { ThemeRoot } from "../../components/theme-root";
import { setupReady } from "../../lib/agents";
import { matchRoute } from "../../lib/query/routes";
import { HOME_PATH } from "../../lib/routes";
import { clientHost } from "../../lib/server/client-host";
import {
  currentNonce,
  currentPath,
  currentSafeUi,
  currentSignInIsNew,
} from "../../lib/server/page";
import { dehydrateFor, prefetchRoute, serverQueryClient } from "../../lib/server/query";
import { getShell } from "../../lib/server/session";
import { workspaceThemeMetadata } from "../../lib/server/theme";
import { setupRouteOf } from "../../lib/setup-routes";

/** The viewer's theme icon, when the theme has one (themes spec §4.3). */
export const generateMetadata = workspaceThemeMetadata;

/**
 * The signed-in pages: the frame (App Shell, setup frame or org chooser) and the session context.
 * On a document request it reads the shell and prefetches the route's queries in one parallel
 * wave (web query cache spec §3.1), and hands both to the browser's cache. The shell's themes read
 * gives the viewer's theme, linked and branded by `ThemeRoot` before the first paint (themes spec
 * §8). The page's client extensions (client extensions spec §11): unless safe mode
 * (`?safe-ui=1` or its session cookie), their import map, preloads and stylesheets, and
 * `ClientHost` around the frame, which imports them after hydration. The first workspace document
 * of a sign-in tells the frame (`sign-in=new`, spec §7.3). Client navigations don't
 * re-render it. The URL has no `(app)`.
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
  // While the org is not ready, a route that is no setup route goes home (the new conversation,
  // where the frame draws the setup home) before anything streams (web-SSR spec §4). Client
  // navigations don't re-render the layout: `useWorkspace()` covers them.
  const pathname = path.split(/[?#]/)[0] ?? "/";
  if (shell.org !== null && shell.readiness !== null && !setupReady(shell.readiness)) {
    if (setupRouteOf(pathname) === "redirect") redirect(HOME_PATH);
  }
  // No page serves the path. `[...rest]` throws `notFound()` itself, below this layout, so its 404
  // renders inside the App Shell.
  if (prefetched.route === "unknown" && matchRoute(pathname) === null) notFound();
  // Safe mode: `?safe-ui=1` or its session cookie, so a refresh after a client navigation (the URL
  // without the parameter) still renders no client code.
  const [safe, host, nonce, newSignIn] = await Promise.all([
    currentSafeUi(),
    clientHost(),
    currentNonce(),
    currentSignInIsNew(),
  ]);
  const source = shell.clientSource;
  return (
    <HydrateCache state={dehydrateFor(qc)}>
      <ThemeRoot orgId={shell.org?.orgId ?? null}>
        {/* after ThemeRoot's theme link, so the plugin stylesheets are ordered after it */}
        <ClientExtensionsHead
          set={shell.client}
          nonce={nonce}
          safe={safe}
          host={host}
          scope={source.kind === "admin" ? "admin" : "org"}
        />
        <ClientHostRoot source={source} safe={safe} hostReady={host !== null}>
          <AppFrame version={`v${pkg.version}`} newSignIn={newSignIn}>
            {children}
          </AppFrame>
        </ClientHostRoot>
      </ThemeRoot>
    </HydrateCache>
  );
}
