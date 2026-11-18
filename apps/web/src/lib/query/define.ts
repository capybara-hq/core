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
  /**
   * Replaces TanStack's structural sharing (`replaceEqualDeep`): what the cache keeps when a read
   * answers (e.g. a newer cached revision over a slow older answer).
   */
  keep?: (old: unknown, next: unknown) => unknown;
}): UseQueryOptions<T, ApiClientError> {
  return queryOptions<T, ApiClientError>({
    queryKey: o.key,
    queryFn: o.fn,
    staleTime: FRESHNESS[o.freshness],
    ...(o.keep !== undefined ? { structuralSharing: o.keep } : {}),
  }) as UseQueryOptions<T, ApiClientError>;
}
