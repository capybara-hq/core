import { type DehydratedState, isServer, QueryClient } from "@tanstack/react-query";
import { ApiClientError } from "../api";

/** A kernel error as it crosses the server -> client boundary (plain, serializable). */
export interface WireError {
  status: number;
  code: string;
  message: string;
}

/** No retry for 4xx; at most one for network errors, upstream_unavailable and 5xx. */
function retry(failureCount: number, error: Error): boolean {
  if (error instanceof ApiClientError && error.status >= 400 && error.status < 500) return false;
  return failureCount < 1;
}

/** A client with the app's defaults. `gcTime` stays at TanStack's default. */
export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry,
        refetchOnWindowFocus: false,
        refetchOnMount: true,
        refetchOnReconnect: true,
      },
    },
  });
}

let browserClient: QueryClient | undefined;

/** One client for the browser session; a new one per call on the server. */
export function browserQueryClient(): QueryClient {
  if (isServer) return makeQueryClient();
  browserClient ??= makeQueryClient();
  return browserClient;
}

/** Hashes of the errors revived from the server that have not been mounted yet (per tab). */
const hydratedErrors = new Set<string>();

/**
 * Rebuilds `ApiClientError`s from the `{ status, code, message }` that `dehydrateFor` wrote; pass
 * the dehydrated state through it before `hydrate` / `HydrationBoundary`. It also records the
 * revived errors so their first mount does not ask the kernel again (see `retryOnMountFor`).
 */
export function reviveDehydrated(state: DehydratedState): DehydratedState {
  return {
    ...state,
    queries: state.queries.map((q) => {
      const e = q.state.error as WireError | null;
      if (!e || e instanceof Error) return q;
      hydratedErrors.add(q.queryHash);
      return {
        ...q,
        state: { ...q.state, error: new ApiClientError(e.status, e.code, e.message) },
      };
    }),
  };
}

/**
 * The observer's `retryOnMount` for a query: false exactly once for an error revived from the
 * server (the server already asked), true after that. A failed query is then read again by the
 * page's retry action or the next mount. Call it once per mount, not on every render.
 */
export function retryOnMountFor(queryHash: string): boolean {
  return !hydratedErrors.delete(queryHash);
}
