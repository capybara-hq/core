import { Button } from "../controls/button";
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
    return (
      <div className="cb-table-empty" data-empty="loading" aria-hidden="true">
        {[52, 40, 60, 44, 36].map((w) => (
          <div key={w} className="cb-table-skel-row">
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
  if (kind === "no-results") {
    return (
      <div className="cb-table-empty" data-part="table-empty" data-empty="no-results">
        <Icon name="search" size={16} />
        <div className="cb-table-empty-title" data-part="table-empty-title">
          {t("table.noResults")}
        </div>
        <div className="cb-table-empty-hint">{noResults?.description}</div>
        {noResults ? <Button onClick={noResults.onClear}>{t("table.clearFilters")}</Button> : null}
      </div>
    );
  }
  return (
    <div className="cb-table-empty" data-part="table-empty" data-empty="empty">
      <Icon name="empty" size={16} />
      <div className="cb-table-empty-title" data-part="table-empty-title">
        {empty?.title ?? t("table.noData")}
      </div>
      {empty?.hint ? <div className="cb-table-empty-hint">{empty.hint}</div> : null}
      {empty?.action}
    </div>
  );
}
