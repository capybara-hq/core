import { Button } from "../controls/button";
import { Select } from "../controls/inputs";
import { useDesignT } from "../provider";

const fmt = (n: number) => n.toLocaleString("en-US");

function pageList(page: number, last: number): (number | "…")[] {
  const set = new Set([1, last, page - 1, page, page + 1].filter((p) => p >= 1 && p <= last));
  const sorted = [...set].sort((a, b) => a - b);
  const out: (number | "…")[] = [];
  let prev = 0;
  for (const p of sorted) {
    if (p - prev > 1) out.push("…");
    out.push(p);
    prev = p;
  }
  return out;
}

export type PaginationProps = {
  page: number;
  pageSize: number;
  total: number;
  pageSizes?: number[];
  onPage: (p: number) => void;
  onPageSize?: (s: number) => void;
};

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
  // 显示时把页码夹到 [1, last]（总数变少、筛选后上层页码可能越界）
  const page = Math.min(last, Math.max(1, Math.floor(requested) || 1));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  const range = total === 0 ? `0 / 0` : `${fmt(from)}–${fmt(to)} / ${fmt(total)}`;
  return (
    <nav className="cb-pagination" aria-label={t("pagination.label")}>
      <span className="cb-pagination-range">{range}</span>
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
      <span className="cb-pagination-pages">
        <Button
          density="dense"
          variant="ghost"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
        >
          {`‹ ${t("pagination.prev")}`}
        </Button>
        {pageList(page, last).map((p, i) =>
          p === "…" ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: 省略号位置固定
            <span key={`e${i}`} className="cb-pagination-gap" aria-hidden="true">
              …
            </span>
          ) : (
            <Button
              key={p}
              density="dense"
              variant={p === page ? "secondary" : "ghost"}
              aria-current={p === page ? "page" : undefined}
              onClick={() => onPage(p)}
            >
              {String(p)}
            </Button>
          ),
        )}
        <Button
          density="dense"
          variant="ghost"
          disabled={page >= last}
          onClick={() => onPage(page + 1)}
        >
          {`${t("pagination.next")} ›`}
        </Button>
      </span>
    </nav>
  );
}
