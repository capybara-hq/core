import { Button } from "../controls/button";
import { Skeleton } from "../display/graphics";
import { Logo } from "../display/logo";
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
    return (
      <div className="cb-table-empty" data-empty="loading">
        <Skeleton rows={6} />
      </div>
    );
  }
  if (kind === "error") {
    return (
      <div className="cb-table-empty" data-empty="error" role="alert">
        <div className="cb-table-empty-title" data-tone="fail">
          {`✗ ${t("table.loadFailed")}`}
        </div>
        {error ? (
          <>
            <div className="cb-table-empty-hint">
              {error.requestId ? `${error.code} · ${error.requestId}` : error.code}
            </div>
            <Button size={24} onClick={error.onRetry}>
              {`↻ ${t("table.retry")}`}
            </Button>
          </>
        ) : null}
      </div>
    );
  }
  if (kind === "no-results") {
    return (
      <div className="cb-table-empty" data-empty="no-results">
        <div className="cb-table-empty-mark" aria-hidden="true">
          ∅
        </div>
        <div className="cb-table-empty-title">{t("table.noResults")}</div>
        <div className="cb-table-empty-hint">{noResults?.description}</div>
        {noResults ? (
          <Button size={24} onClick={noResults.onClear}>
            {t("table.clearFilters")}
          </Button>
        ) : null}
      </div>
    );
  }
  return (
    <div className="cb-table-empty" data-empty="empty">
      <Logo tone="muted" />
      <div className="cb-table-empty-title">{empty?.title ?? t("table.noData")}</div>
      {empty?.hint ? <div className="cb-table-empty-hint">{empty.hint}</div> : null}
      {empty?.action}
    </div>
  );
}
