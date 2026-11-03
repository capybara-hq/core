import {
  queryOptions,
  type UseQueryOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import type { ApiClientError } from "../api";
import { FRESHNESS, type Freshness } from "./freshness";

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

/**
 * A write that invalidates the listed keys (awaited) before the caller's `onSuccess` runs.
 *
 * `forgetsOnLeave` lists what a successful write made unreadable (my own delete: the detail I
 * leave). Those queries are removed when the calling component unmounts, so Back does not paint the
 * deleted object from the cache. Removing them earlier, while the view still observes them, would
 * read them again and flash the not-found state before the navigation lands.
 */
export function useAppMutation<V, R>(o: {
  fn: (v: V) => Promise<R>;
  invalidates: (v: V, r: R) => (readonly unknown[])[];
  forgetsOnLeave?: (v: V, r: R) => (readonly unknown[])[];
  onSuccess?: (r: R, v: V) => void;
}) {
  const qc = useQueryClient();
  const forgotten = useRef<(readonly unknown[])[]>([]);
  useEffect(
    () => () => {
      for (const queryKey of forgotten.current) qc.removeQueries({ queryKey });
      forgotten.current = [];
    },
    [qc],
  );
  return useMutation<R, ApiClientError, V>({
    mutationFn: o.fn,
    onSuccess: async (r, v) => {
      await Promise.all(o.invalidates(v, r).map((queryKey) => qc.invalidateQueries({ queryKey })));
      if (o.forgetsOnLeave) forgotten.current.push(...o.forgetsOnLeave(v, r));
      o.onSuccess?.(r, v);
    },
  });
}
