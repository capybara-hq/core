import "server-only";
import {
  type DehydratedState,
  defaultShouldDehydrateQuery,
  dehydrate,
  type QueryClient,
} from "@tanstack/react-query";
import { redirect } from "next/navigation";
import { cache } from "react";
import { ApiClientError } from "../api";
import { loginPathFor } from "../auth-sources";
import { makeQueryClient, type WireError } from "../query/client";
import { matchRoute, type RouteCtx, UNKNOWN_ROUTE } from "../query/routes";
import type { Me } from "../session";
import { isSignedOut } from "../signed-out";

/** One query client per server request. */
export const serverQueryClient = cache((): QueryClient => makeQueryClient());

/**
 * Dehydrates the client for a `HydrationBoundary`: successes and failures. An
 * `ApiClientError` is stored as `{ status, code, message }` (class instances cannot cross to the
 * client); `reviveDehydrated` rebuilds it there.
 */
export function dehydrateFor(qc: QueryClient): DehydratedState {
  const state = dehydrate(qc, {
    shouldDehydrateQuery: (q) => defaultShouldDehydrateQuery(q) || q.state.status === "error",
    shouldRedactErrors: () => false,
  });
  return {
    ...state,
    queries: state.queries.map((q) => {
      const e = q.state.error;
      if (!(e instanceof ApiClientError)) return q;
      const wire: WireError = { status: e.status, code: e.code, message: e.message };
      return { ...q, state: { ...q.state, error: wire as unknown as Error } };
    }),
  };
}

/**
 * The first-load prefetch of a route (web query cache spec §3.1): the matched entry's queries, in
 * parallel, then its `then` (reads that need those answers). `"unknown"` when no page serves the
 * path or it falls to `[...rest]`. With `signedOutRedirect` (the (app) pages), a read that finds the
 * session gone redirects to sign-in, back to `path`; the public (auth) pages pass `false`. Any
 * other failure stays in the cache (dehydrated, the page draws it).
 */
export async function prefetchRoute(
  qc: QueryClient,
  path: string,
  session: { me: Me | null; orgId: string | null },
  opts: { signedOutRedirect: boolean } = { signedOutRedirect: true },
): Promise<"ok" | "unknown"> {
  const match = matchRoute(path);
  if (match === null || match.entry.pattern === UNKNOWN_ROUTE) return "unknown";
  const ctx: RouteCtx = { params: match.params, search: match.search, ...session };
  const queries = match.entry.queries(ctx);
  // A server read is not retried: the first paint waits for it, and the page's retry action or
  // the browser reads it again.
  await Promise.all(queries.map((q) => qc.prefetchQuery({ ...q, retry: false })));
  // `then` only prefetches: a failure of it must not fail the layout. The queries it started stay
  // in the cache in whatever state they reached, and the signed-out check below still runs.
  try {
    await match.entry.then?.(ctx, qc);
  } catch {}
  if (!opts.signedOutRedirect) return "ok";
  const signedOut = qc
    .getQueryCache()
    .getAll()
    .some((q) => isSignedOut(q.state.error));
  if (signedOut) redirect(loginPathFor(path));
  return "ok";
}
