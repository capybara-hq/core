import type { Query, QueryClient } from "@tanstack/react-query";
import { getUiView, type UiLocale } from "../ui";
import { defineQuery } from "./define";
import { keys } from "./keys";

/** One extension view to read: a contribution, with an open target's item or a card's call. */
export interface UiViewTarget {
  plugin: string;
  id: string;
  item?: string;
  card?: { callId: string; key?: string };
}

/**
 * One extension view (its own request, 10 s timeout; aborted when nothing reads it any more).
 * `conversationId` scopes it to a conversation (`"org"` scope without one). Each read is the
 * extension rendering it again, so it is never fresh by time: refreshes (`event: ui`) and retries
 * read it.
 */
export const uiViewQuery = (
  orgId: string,
  t: UiViewTarget,
  opts: { conversationId?: string; locale: UiLocale },
) =>
  defineQuery({
    key: keys
      .org(orgId)
      .uiView(
        opts.conversationId ?? "org",
        t.plugin,
        t.id,
        JSON.stringify([opts.locale, t.item ?? null, t.card ?? null]),
      ),
    fn: ({ signal }) =>
      getUiView(orgId, t.plugin, t.id, {
        ...(opts.conversationId !== undefined && { conversationId: opts.conversationId }),
        locale: opts.locale,
        ...(t.item !== undefined && { item: t.item }),
        ...(t.card !== undefined && { card: t.card }),
        signal,
      }).then((r) => r.view),
    freshness: "live",
  });

/** Per client: views with a read in flight, and those a refresh arrived for meanwhile. */
const coalescing = new WeakMap<QueryClient, { inflight: Set<string>; again: Set<string> }>();

/**
 * Refreshes the extension views under `queryKey` (`keys.org(o).uiViews(...)`), coalesced (final
 * review I1): at most one read per view is in flight, and refreshes arriving meanwhile (any number)
 * cause one more read after it. A read in flight that a refresh did not start (the first read, a
 * catch-up invalidation) may predate the change, so one more read follows it. A view nothing shows
 * now (an inline card out of view) is only marked stale: it is read when it shows again.
 */
export function refreshUiViews(qc: QueryClient, queryKey: readonly unknown[]): void {
  const state = coalescing.get(qc) ?? { inflight: new Set<string>(), again: new Set<string>() };
  coalescing.set(qc, state);
  // Every view under the key goes stale (one out of view reads when it shows again).
  void qc.invalidateQueries({ queryKey, refetchType: "none" });
  // query-exempt: a cache filter (the views shown now), not a query definition
  for (const q of qc.getQueryCache().findAll({ queryKey, type: "active" })) {
    if (state.inflight.has(q.queryHash)) {
      state.again.add(q.queryHash);
      continue;
    }
    void readUntilCurrent(qc, q, state);
  }
}

async function readUntilCurrent(
  qc: QueryClient,
  q: Query,
  state: { inflight: Set<string>; again: Set<string> },
): Promise<void> {
  state.inflight.add(q.queryHash);
  const read = () =>
    qc
      .refetchQueries({ queryKey: q.queryKey, exact: true }, { cancelRefetch: false })
      .catch(() => {});
  try {
    // A read in flight now is not a refresh's (those are awaited below): the first read or another
    // invalidation's, begun before the change this refresh reports, so its answer may predate it.
    // Let it finish, then read again; joining it would keep the old view.
    if (q.state.fetchStatus !== "idle") await read();
    do {
      state.again.delete(q.queryHash);
      await read();
    } while (state.again.has(q.queryHash));
  } finally {
    state.inflight.delete(q.queryHash);
  }
}
