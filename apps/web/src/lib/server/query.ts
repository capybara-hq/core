import "server-only";
import {
  type DehydratedState,
  defaultShouldDehydrateQuery,
  dehydrate,
  type QueryClient,
} from "@tanstack/react-query";
import { cache } from "react";
import { ApiClientError } from "../api";
import { makeQueryClient, type WireError } from "../query/client";

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
