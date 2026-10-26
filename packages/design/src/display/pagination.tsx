import { IconButton } from "../controls/button";
import { Select } from "../controls/inputs";
import { Icon } from "../icons/icon";
import { useDesignT } from "../provider";

const fmt = (n: number) => n.toLocaleString("en-US");

export type PaginationProps = {
  page: number;
  pageSize: number;
  total: number;
  pageSizes?: number[];
  onPage: (p: number) => void;
  onPageSize?: (s: number) => void;
};

/**
 * Pagination (spec §6.4, the signed reference): "N total · page x / y" on the left, the optional
 * per-page select, then icon-only previous / next buttons (`default`, `dense`) at the right edge.
 */
export function Pagination({
  page: requested,
  pageSize,
  total,
  pageSizes,
  onPage,
  onPageSize,
}: PaginationProps) {
  const t = useDesignT();
  const last = Math.max(1, Math.ceil(total / pageSize));
  // clamp the shown page to [1, last] (the total can shrink, a filter can leave the page past it)
  const page = Math.min(last, Math.max(1, Math.floor(requested) || 1));
  const summary = t("pagination.summary")
    .replace("{total}", fmt(total))
    .replace("{page}", fmt(page))
    .replace("{last}", fmt(last));
  return (
    <nav className="cb-pagination" data-part="pagination" aria-label={t("pagination.label")}>
      <span className="cb-pagination-info" data-part="pagination-info">
        {summary}
      </span>
      {pageSizes && onPageSize ? (
        <Select
          aria-label={t("pagination.perPage")}
          value={String(pageSize)}
          onChange={(e) => onPageSize(Number(e.target.value))}
          options={pageSizes.map((s) => ({
            value: String(s),
            label: `${t("pagination.perPage")} ${s}`,
          }))}
        />
      ) : null}
      <IconButton
        density="dense"
        variant="default"
        label={t("pagination.prev")}
        icon={<Icon name="chevron-left" size={14} />}
        disabled={page <= 1}
        onClick={() => onPage(page - 1)}
      />
      <IconButton
        density="dense"
        variant="default"
        label={t("pagination.next")}
        icon={<Icon name="chevron-right" size={14} />}
        disabled={page >= last}
        onClick={() => onPage(page + 1)}
      />
    </nav>
  );
}
