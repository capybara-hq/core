import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { HydrateCache } from "../../components/HydrateCache";
import { ThemeRoot } from "../../components/theme-root";
import { matchRoute } from "../../lib/query/routes";
import { platformThemeQuery } from "../../lib/query/themes";
import { currentPath } from "../../lib/server/page";
import { dehydrateFor, prefetchRoute, serverQueryClient } from "../../lib/server/query";
import { platformThemeMetadata } from "../../lib/server/theme";

/** The platform default theme's icon, when it has one (themes spec §4.3). */
export const generateMetadata = platformThemeMetadata;

/**
 * The public pages (sign-in, setup, invitation, binding): on a document request, the route's
 * queries are prefetched and handed to the browser's cache (web query cache spec §3.1). No shell
 * and no session read of its own: a page that needs the visitor's session lists `maybeMeQuery`.
 * A signed-out answer is the page's business here, never a redirect. The platform default theme is
 * read beside the route (themes spec §8): linked and branded by `ThemeRoot` before the first paint;
 * a failed read is the built-in theme. The URL has no `(auth)`.
 */
export default async function AuthLayout({ children }: { children: ReactNode }) {
  const qc = serverQueryClient();
  const path = await currentPath();
  const [route] = await Promise.all([
    prefetchRoute(qc, path, { me: null, orgId: null }, { signedOutRedirect: false }),
    // a failure stays in the cache (dehydrated): ThemeRoot draws the built-in theme
    qc.fetchQuery({ ...platformThemeQuery(), retry: false }).catch(() => null),
  ]);
  if (route === "unknown" && matchRoute(path) === null) notFound();
  return (
    <HydrateCache state={dehydrateFor(qc)}>
      <ThemeRoot orgId={null}>{children}</ThemeRoot>
    </HydrateCache>
  );
}
