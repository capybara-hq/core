import {
  queryOptions,
  type UseQueryOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import type { ApiClientError } from "../api";
import { FRESHNESS, type Freshness } from "./freshness";

/** The one way to declare a read: a key, the loader call and its freshness class. */
export function defineQuery<T>(o: {
  key: readonly unknown[];
  fn: () => Promise<T>;
  freshness: Freshness;
}): UseQueryOptions<T, ApiClientError> {
  return queryOptions<T, ApiClientError>({
    queryKey: o.key,
    queryFn: o.fn,
    staleTime: FRESHNESS[o.freshness],
  }) as UseQueryOptions<T, ApiClientError>;
}

/** A write that invalidates the listed keys (awaited) before the caller's `onSuccess` runs. */
export function useAppMutation<V, R>(o: {
  fn: (v: V) => Promise<R>;
  invalidates: (v: V, r: R) => (readonly unknown[])[];
  onSuccess?: (r: R, v: V) => void;
}) {
  const qc = useQueryClient();
  return useMutation<R, ApiClientError, V>({
    mutationFn: o.fn,
    onSuccess: async (r, v) => {
      await Promise.all(o.invalidates(v, r).map((queryKey) => qc.invalidateQueries({ queryKey })));
      o.onSuccess?.(r, v);
    },
  });
}
