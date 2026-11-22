import type { ReactNode } from "react";
import { Button } from "../controls/button";
import { useDesignT } from "../provider";
import { ClassForms, useClassForm } from "../shell/class-forms";
import { useListSentinel } from "./list-sentinel";

/**
 * The paging props of a list with a cursor (ObjectList, CardGrid, DataTable, ItemList; mobile interaction
 * model spec §3 "Infinite scroll", D6). Below 600 the next page is read as the list's end comes
 * into view, with a skeleton row while it loads and an inline retry row on a failure; from 600 up
 * the list draws a Load more button under it. A page passes these and never draws its own
 * Load more button (`web-ui-load-more`).
 */
export type ListMoreProps = {
  /** Reads the next page; the retry of a failed read too. Without it the list has no end. */
  onLoadMore?: (() => void) | undefined;
  /** There are more pages after the last row. */
  hasMore?: boolean | undefined;
  /**
   * The next page is being read. Required with `onLoadMore` in practice: the compact end asks
   * once and arms again only after `loadingMore` went true and back (or `hasMore` came back), so a
   * list that never reports its loading reads one page by scrolling and no more.
   */
  loadingMore?: boolean | undefined;
  /** The last read failed: its localized message, shown with Retry until the next try. */
  loadMoreError?: string | null | undefined;
};

/** Explicit table roles, spread because a linter only sees the elements (DataTable's ROLE). */
const ROW = { role: "row" } as const;
const CELL = { role: "cell" } as const;
const NONE = { role: "none" } as const;

/**
 * The compact end of a list (inside its grouped card): the sentinel, the list's own skeleton row
 * while the next page loads (`skeleton`, marked `data-end="skeleton"` by the caller), and the
 * failure with Retry. Drawn only once the compact class is known (the sentinel needs script).
 * `as`: the element the list's rows are (`li` in a list, `div` rows in a table, `row`: with the
 * table's row and cell roles).
 */
export function ListEnd({
  more,
  skeleton,
  as = "li",
}: {
  more: ListMoreProps;
  skeleton: ReactNode;
  as?: "li" | "div" | "row";
}) {
  const t = useDesignT();
  const form = useClassForm();
  const { onLoadMore, hasMore = false, loadingMore = false, loadMoreError = null } = more;
  const failed = loadMoreError !== null;
  const sentinel = useListSentinel(() => onLoadMore?.(), {
    hasMore: hasMore && !failed && onLoadMore !== undefined && form === "compact",
    loading: loadingMore,
  });
  if (form !== "compact" || onLoadMore === undefined || !hasMore) return null;
  const state = failed ? "error" : loadingMore ? "loading" : "idle";
  // Always mounted while the end is, so the loading announcement is heard; filled only then.
  const live = (
    <span className="cb-sr-only" role="status">
      {state === "loading" ? t("table.loading") : ""}
    </span>
  );
  const failure =
    state === "error" ? (
      <>
        <span className="cb-list-end-error">{loadMoreError}</span>
        <Button variant="ghost" onClick={onLoadMore}>
          {t("table.retry")}
        </Button>
      </>
    ) : null;
  const attrs = {
    className: "cb-list-end",
    "data-part": "list-end",
    "data-state": state,
  } as const;
  // Idle and loading, the end is no row to assistive tech (role none), only its live region.
  const none = state === "error" ? {} : NONE;
  return (
    <>
      {state === "loading" ? skeleton : null}
      {as === "li" ? (
        <li ref={sentinel} {...attrs} {...none}>
          {live}
          {failure}
        </li>
      ) : as === "row" ? (
        // The table's roles are explicit (spread, as DataTable's ROLE): a row of one cell.
        <div ref={sentinel} {...attrs} {...(state === "error" ? ROW : NONE)}>
          {live}
          {failure === null ? null : (
            <span {...CELL} className="cb-list-end-cell">
              {failure}
            </span>
          )}
        </div>
      ) : (
        <div ref={sentinel} {...attrs}>
          {live}
          {failure}
        </div>
      )}
    </>
  );
}

/**
 * The wide end of a list: a Load more button under it (the desktop keeps its button, D6), waiting
 * while the page loads, the failure beside it. Nothing on the last page or below 600.
 */
export function ListMoreButton({ more }: { more: ListMoreProps }) {
  const t = useDesignT();
  const { onLoadMore, hasMore = false, loadingMore = false, loadMoreError = null } = more;
  if (onLoadMore === undefined || !hasMore) return null;
  return (
    <ClassForms
      compact={null}
      wide={
        <div className="cb-list-more" data-part="list-more">
          <Button loading={loadingMore} onClick={onLoadMore}>
            {t("table.loadMore")}
          </Button>
          {loadMoreError !== null ? (
            <span className="cb-list-more-error">{loadMoreError}</span>
          ) : null}
        </div>
      }
    />
  );
}
