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

/** A client with the app's defaults (`retryOnMount: false`: a failed query is retried explicitly). `gcTime` stays at TanStack's default. */
export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry,
        refetchOnWindowFocus: false,
        refetchOnMount: true,
        refetchOnReconnect: true,
        // An observer option (a hydrated query cannot carry it): a mounting component does not
        // re-run a query that already failed, so a hydrated server error is not asked twice.
        retryOnMount: false,
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

/**
 * Rebuilds `ApiClientError`s from the `{ status, code, message }` that `dehydrateFor` wrote; pass
 * the dehydrated state through it before `hydrate` / `HydrationBoundary`.
 */
export function reviveDehydrated(state: DehydratedState): DehydratedState {
  return {
    ...state,
    queries: state.queries.map((q) => {
      const e = q.state.error as WireError | null;
      if (!e || e instanceof Error) return q;
      return {
        ...q,
        state: { ...q.state, error: new ApiClientError(e.status, e.code, e.message) },
      };
    }),
  };
}
