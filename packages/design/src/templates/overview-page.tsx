import type { ReactNode } from "react";
import { SkeletonGroup } from "../display/index";
import { useDesignT } from "../provider";
import { Body, type PageHeaderProps } from "../shell/index";
import { LoadingCards, LoadingStats, loadingHeader, TemplateHead, WithStats } from "./frame";

/** What a loading overview draws when it is not told (spec §5). */
const LOADING_STATS = 4;
const LOADING_SECTIONS = 2;

/**
 * T1 Overview: Single, list width. `loading` draws the page's frame while its data is on the way:
 * the header keeps its rows, `stats` stat cards (default 4; the header's own `metrics` render for
 * real instead) and `sections` card-shaped blocks (default 2) in place of `children`. A page whose
 * content does not depend on the data (a note under the numbers) passes `keep`: the
 * children render as they are under the stat slots, in place of the blocks.
 */
export function OverviewPage({
  header,
  loading,
  children,
}: {
  header: PageHeaderProps;
  loading?: {
    stats?: number;
    sections?: number;
    /** The children do not depend on the data: they render as they are, no blocks. */
    keep?: boolean;
  };
  children?: ReactNode;
}) {
  const t = useDesignT();
  if (loading) {
    const known = (header.metrics?.length ?? 0) > 0;
    return (
      <div className="cb-template" data-template="OverviewPage" data-width="content">
        <SkeletonGroup label={header.title || t("table.loading")}>
          <TemplateHead header={loadingHeader(header)} />
          <Body layout="single" width="content">
            {known ? null : <LoadingStats count={loading.stats ?? LOADING_STATS} />}
            <WithStats header={header}>
              {loading.keep ? (
                children
              ) : (
                <LoadingCards count={loading.sections ?? LOADING_SECTIONS} />
              )}
            </WithStats>
          </Body>
        </SkeletonGroup>
      </div>
    );
  }
  return (
    <div className="cb-template" data-template="OverviewPage" data-width="content">
      <TemplateHead header={header} />
      <Body layout="single" width="content">
        <WithStats header={header}>{children}</WithStats>
      </Body>
    </div>
  );
}
