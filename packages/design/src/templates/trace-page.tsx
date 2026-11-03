import type { ReactNode } from "react";
import { SkeletonGroup, SkeletonText } from "../display/index";
import { useDesignT } from "../provider";
import { Body, type PageHeaderProps } from "../shell/index";
import { LoadingCards, LoadingStats, loadingHeader, TemplateHead } from "./frame";

/** Waterfall rows and stat slots a loading trace page draws when it is not told how many (§5.11). */
const LOADING_SPANS = 6;
const LOADING_STATS = 4;

/** The loaded waterfall's own container and rows, with a name line and a duration in each. */
function LoadingWaterfall({ rows }: { rows: number }) {
  return (
    <div className="cb-waterfall" data-part="loading-waterfall">
      {Array.from({ length: Math.max(0, rows) }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the placeholders are positional
        <div key={i} className="cb-waterfall-row" data-part="loading-span-row" data-loading="true">
          <div className="cb-waterfall-name">
            <SkeletonText width={i % 2 === 0 ? "70%" : "55%"} />
          </div>
          <div className="cb-waterfall-track" />
          <div className="cb-waterfall-status" />
          <div className="cb-waterfall-ms">
            <SkeletonText width="100%" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * T8 trace viewer (spec §5.11): Single in the content width; the span waterfall and the selected
 * span's detail right after it, or, from 1280, the detail as a 400 px right panel inside the width,
 * each column scrolling on its own. `loading` draws the frame while the trace is on the way: the
 * header keeps its rows, the stats are `stats` slots (default 4) unless the header carries real
 * `metrics`, the waterfall is `spans` rows (default 6) in the waterfall's own container and row
 * box, and the detail is a card-shaped block.
 */
export function TracePage({
  header,
  waterfall,
  detail,
  loading,
}: {
  header: PageHeaderProps;
  waterfall: ReactNode;
  detail: ReactNode;
  loading?: { spans?: number; stats?: number };
}) {
  const t = useDesignT();
  const known = (header.metrics ?? []).length > 0;
  const page = (
    <>
      <TemplateHead header={loading ? loadingHeader(header) : header} statsInHead>
        {loading && !known ? <LoadingStats count={loading.stats ?? LOADING_STATS} /> : null}
      </TemplateHead>
      <Body layout="single" width="content">
        <div className="cb-trace">
          <div className="cb-trace-waterfall">
            {loading ? <LoadingWaterfall rows={loading.spans ?? LOADING_SPANS} /> : waterfall}
          </div>
          <div className="cb-trace-detail">{loading ? <LoadingCards count={1} /> : detail}</div>
        </div>
      </Body>
    </>
  );
  return (
    <div className="cb-template" data-template="TracePage" data-width="content">
      {loading ? (
        <SkeletonGroup label={header.title || t("table.loading")}>{page}</SkeletonGroup>
      ) : (
        page
      )}
    </div>
  );
}
