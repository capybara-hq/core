import { type DehydratedState, hashKey, isServer, QueryClient } from "@tanstack/react-query";
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

/**
 * Hashes of the errors revived from the server for the current document (per tab). They stay
 * recorded until the first client navigation to another path ({@link noteClientPath}), so a first
 * mount and a StrictMode re-mount on the document's path both skip the refetch.
 */
const hydratedErrors = new Set<string>();
/** The path the recorded errors belong to; `null` until the first {@link noteClientPath}. */
let errorsPath: string | null = null;

/**
 * Rebuilds `ApiClientError`s from the `{ status, code, message }` that `dehydrateFor` wrote; pass
 * the dehydrated state through it before `hydrate` / `HydrationBoundary`, in the browser only. It
 * also records the revived errors so mounting them does not ask the kernel again (see
 * `isHydratedError`).
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
 * Whether a query's error came from the server for this document: its observers pass
 * `retryOnMount: !isHydratedError(hash)` (the server already asked). A failed query is then read
 * again by the page's retry action or by a mount after the next client navigation.
 */
export function isHydratedError(queryHash: string): boolean {
  return hydratedErrors.has(queryHash);
}

/** The observer option for a query's key: no refetch on mount for an error from the server. */
export const retryOnMountOf = (queryKey: readonly unknown[]): boolean =>
  !isHydratedError(hashKey(queryKey));

/**
 * Called with the browser's pathname on every render of the provider: the first call records the
 * document's path, a different one (a client navigation away) forgets the revived errors.
 */
export function noteClientPath(pathname: string): void {
  if (errorsPath === null) {
    errorsPath = pathname;
    return;
  }
  if (pathname === errorsPath) return;
  errorsPath = pathname;
  hydratedErrors.clear();
}
