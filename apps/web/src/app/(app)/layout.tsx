import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import pkg from "../../../package.json";
import { AppFrame } from "../../components/shell/AppFrame";
import { KernelStarting } from "../../components/shell/KernelStarting";
import { setupReady } from "../../lib/agents";
import { currentPath } from "../../lib/server/page";
import { getShell } from "../../lib/server/session";
import { setupRouteOf } from "../../lib/setup-routes";

/**
 * The signed-in pages: the frame (App Shell, setup frame or org chooser) drawn from the shell data
 * read on the server, and the session context. The URL has no `(app)`.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  // Signed out or a fresh deployment never gets here: the proxy (src/proxy.ts) redirects first.
  const shell = await getShell();
  // The kernel cannot answer (starting, restarting): a frame that retries by itself (ruling R2).
  if (shell.kind === "unavailable") return <KernelStarting />;
  // While the org is not ready, a route that is no setup route goes home before anything streams
  // (web-SSR spec §4). Client navigations don't re-render the layout: `workspace()` covers them.
  if (shell.org !== null && shell.readiness !== null && !setupReady(shell.readiness)) {
    const path = (await currentPath()).split(/[?#]/)[0] ?? "/";
    if (setupRouteOf(path) === "redirect") redirect("/");
  }
  const { kind: _, ...initial } = shell;
  return (
    <AppFrame initial={initial} version={`v${pkg.version}`}>
      {children}
    </AppFrame>
  );
}
