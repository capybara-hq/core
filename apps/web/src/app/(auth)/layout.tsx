import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { HydrateCache } from "../../components/HydrateCache";
import { matchRoute } from "../../lib/query/routes";
import { currentPath } from "../../lib/server/page";
import { dehydrateFor, prefetchRoute, serverQueryClient } from "../../lib/server/query";

/**
 * The public pages (sign-in, setup, invitation, binding): on a document request, the route's
 * queries are prefetched and handed to the browser's cache (web query cache spec §3.1). No shell
 * and no session read of its own: a page that needs the visitor's session lists `maybeMeQuery`.
 * A signed-out answer is the page's business here, never a redirect. The URL has no `(auth)`.
 */
export default async function AuthLayout({ children }: { children: ReactNode }) {
  const qc = serverQueryClient();
  const path = await currentPath();
  const route = await prefetchRoute(
    qc,
    path,
    { me: null, orgId: null },
    { signedOutRedirect: false },
  );
  if (route === "unknown" && matchRoute(path) === null) notFound();
  return <HydrateCache state={dehydrateFor(qc)}>{children}</HydrateCache>;
}
