"use client";

import { Button, Stack, Text } from "@capybara-hq/design";
import { type UseQueryOptions, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { ApiClientError } from "../lib/api";
import { useErrorMessage } from "../lib/use-error-message";

/** A page's rows and the cursor of the page after it (null on the last). */
export interface CursorSlice<R> {
  rows: readonly R[];
  next: string | null;
}

/**
 * The rows of a cursor-paged list shown by Load more: the first page (from the query cache,
 * undefined while it is read) and the later pages read through the cache by cursor
 * (`pageQuery(after)`) and appended; `select` reads a page's rows and next cursor. Later pages
 * belong to the first page they continue: a first page with another identity (a refetch that
 * changed it; the query cache keeps the identity of an unchanged answer) starts over. A failed
 * Load more leaves the rows as they are and gives `error` (the localized message), shown by
 * {@link LoadMore} until the next try.
 */
export function useCursorPages<P, R>(
  first: P | undefined,
  pageQuery: (after: string) => UseQueryOptions<P, ApiClientError>,
  select: (page: P) => CursorSlice<R>,
): {
  rows: R[];
  next: string | null;
  loadingMore: boolean;
  error: string | null;
  loadMore: () => void;
} {
  const qc = useQueryClient();
  const errorMessage = useErrorMessage();
  const [more, setMore] = useState<{ source: P | undefined; pages: P[]; error: string | null }>({
    source: first,
    pages: [],
    error: null,
  });
  const [loadingMore, setLoadingMore] = useState(false);
  const current = more.source === first;
  const pages = current ? more.pages : [];
  const error = current ? more.error : null;
  if (first === undefined) return { rows: [], next: null, loadingMore, error, loadMore: () => {} };
  const slices = [first, ...pages].map(select);
  const rows = slices.flatMap((s) => [...s.rows]);
  const next = (slices.at(-1) as CursorSlice<R>).next;
  const loadMore = () => {
    if (next === null || loadingMore) return;
    setLoadingMore(true);
    setMore({ source: first, pages, error: null });
    qc.fetchQuery(pageQuery(next))
      .then((page) => setMore({ source: first, pages: [...pages, page], error: null }))
      .catch((e: unknown) => setMore({ source: first, pages, error: errorMessage(e) }))
      .finally(() => setLoadingMore(false));
  };
  return { rows, next, loadingMore, error, loadMore };
}

/** The Load more row of a {@link useCursorPages} list: nothing on the last page. */
export function LoadMore({
  pages,
  label,
}: {
  pages: Pick<ReturnType<typeof useCursorPages>, "next" | "loadingMore" | "error" | "loadMore">;
  label: string;
}) {
  if (pages.next === null) return null;
  return (
    <Stack direction="row" gap={8} align="center">
      <Button loading={pages.loadingMore} onClick={pages.loadMore}>
        {label}
      </Button>
      {pages.error !== null && <Text tone="fail">{pages.error}</Text>}
    </Stack>
  );
}
