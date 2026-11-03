"use client";

import { type UseQueryOptions, useQuery } from "@tanstack/react-query";
import type { ApiClientError } from "../api";
import { retryOnMountOf } from "./client";

/** What a page draws for its main read (web query cache spec §3.2, §3.3). */
export type PageState<T> =
  | { kind: "loading" }
  | { kind: "ready"; data: T; refreshing: boolean }
  | { kind: "notFound" }
  | { kind: "error"; code: string; retry(): void };

/**
 * A page's main read as the state its view draws. A 404 is `notFound` even when stale data is
 * cached: the latest answer wins, so an object deleted elsewhere is not shown from the cache. Any
 * other failure is `error` (with the kernel code) only without data to show; a failed background
 * refetch keeps the cached data. An error the server already read is not read again on mount (see
 * `isHydratedError`); `retry` reads it.
 */
export function usePageQuery<T>(o: UseQueryOptions<T, ApiClientError>): PageState<T> {
  const q = useQuery({ ...o, retryOnMount: retryOnMountOf(o.queryKey) });
  if (q.error?.status === 404) return { kind: "notFound" };
  if (q.data !== undefined) return { kind: "ready", data: q.data, refreshing: q.isFetching };
  if (q.error) return { kind: "error", code: q.error.code, retry: () => void q.refetch() };
  return { kind: "loading" };
}
