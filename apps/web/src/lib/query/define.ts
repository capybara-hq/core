import { queryOptions, type UseQueryOptions } from "@tanstack/react-query";
import type { ApiClientError } from "../api";
import { FRESHNESS, type Freshness } from "./freshness";

// Server layouts import this module (they prefetch through `defineQuery` options): it holds no
// hooks. Writes are `useAppMutation` in `./mutation`, a client-only hook module.

/** The one way to declare a read: a key, the loader call and its freshness class. */
export function defineQuery<T>(o: {
  key: readonly unknown[];
  /** Receives TanStack's query function context; `signal` aborts when the read is cancelled. */
  fn: (ctx: { signal: AbortSignal }) => Promise<T>;
  freshness: Freshness;
}): UseQueryOptions<T, ApiClientError> {
  return queryOptions<T, ApiClientError>({
    queryKey: o.key,
    queryFn: o.fn,
    staleTime: FRESHNESS[o.freshness],
  }) as UseQueryOptions<T, ApiClientError>;
}
