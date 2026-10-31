import { Button } from "../controls/button";
import { EmptyState } from "../display/empty-state";
import { Icon } from "../icons/icon";
import { useDesignT } from "../provider";
import type { DataTableProps } from "./types";

export function EmptyArea<T>({
  kind,
  error,
  empty,
  noResults,
}: {
  kind: "loading" | "empty" | "no-results" | "error";
  error?: DataTableProps<T>["error"] | undefined;
  empty?: DataTableProps<T>["empty"] | undefined;
  noResults?: DataTableProps<T>["noResults"] | undefined;
}) {
  const t = useDesignT();
  if (kind === "loading") {
    // Skeleton rows under the header, row.dense high (spec §6.6); no spinner.
    // The bars are decorative; the status text is for assistive tech.
    return (
      <div className="cb-table-empty" data-empty="loading" role="status">
        <span className="cb-sr-only">{t("table.loading")}</span>
        {[52, 40, 60, 44, 36].map((w) => (
          <div key={w} className="cb-table-skel-row" aria-hidden="true">
            <span className="cb-table-skel" data-part="skeleton-bar" data-width={w} />
          </div>
        ))}
      </div>
    );
  }
  if (kind === "error") {
    return (
      <div className="cb-table-empty" data-part="table-empty" data-empty="error" role="alert">
        <div className="cb-table-empty-title" data-part="table-empty-title" data-tone="fail">
          <Icon name="circle-x" size={14} />
          <span>{t("table.loadFailed")}</span>
        </div>
        {error ? (
          <>
            <div className="cb-table-empty-hint">
              {error.requestId ? `${error.code} · ${error.requestId}` : error.code}
            </div>
            <Button onClick={error.onRetry}>
              <Icon name="refresh" size={14} />
              {t("table.retry")}
            </Button>
          </>
        ) : null}
      </div>
    );
  }
  // Empty and no results: the one empty state, compact, inside the table (spec §6.6, §6.18).
  if (kind === "no-results") {
    return (
      <div className="cb-table-empty" data-part="table-empty" data-empty="no-results">
        <EmptyState
          size="compact"
          icon="search-x"
          text={t("table.noResults")}
          {...(noResults?.description ? { hint: noResults.description } : {})}
          {...(noResults
            ? { action: <Button onClick={noResults.onClear}>{t("table.clearFilters")}</Button> }
            : {})}
        />
      </div>
    );
  }
  return (
    <div className="cb-table-empty" data-part="table-empty" data-empty="empty">
      <EmptyState
        size="compact"
        text={empty?.title ?? t("table.noData")}
        {...(empty?.hint ? { hint: empty.hint } : {})}
        {...(empty?.action != null ? { action: <>{empty.action}</> } : {})}
      />
    </div>
  );
}
