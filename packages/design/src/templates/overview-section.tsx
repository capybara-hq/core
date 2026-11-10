import type { ReactNode } from "react";
import { ErrorDetail } from "../display/error-detail";
import { SkeletonGroup } from "../display/skeleton";
import { Icon } from "../icons/icon";
import { CardFrame } from "../layout/index";
import { useDesignT } from "../provider";
import { type BlockShape, LoadingBlocks } from "./frame";

/** What a loading section draws when it is not told: a few lines. */
const DEFAULT_LOADING: BlockShape[] = [{ kind: "lines", lines: 3 }];

export type OverviewSectionState = "loading" | "error" | "ready";

export type OverviewSectionError = {
  /** One sentence in the reader's language (「无法加载运行状况。」), never the raw text. */
  summary: string;
  /** The raw text (a kernel message, a network error), behind the 原始错误 toggle. */
  detail?: string;
  /** Reads the section again; only this section. */
  onRetry(): void;
};

export type OverviewSectionProps = {
  /** The section's name, in the card's head; also the busy region's name while loading. */
  title: string;
  /** The head's actions (查看全部); static, so they stay while loading and on error. */
  actions?: ReactNode;
  state: OverviewSectionState;
  /** The loaded block's shape while loading (spec §5.2 `BlockShape`); default a few lines. */
  loading?: BlockShape[];
  /** What failed, with `state="error"`. */
  error?: OverviewSectionError;
  /** The loaded content: ItemList rows, an unframed DataTable, Subsections; never a box. */
  children?: ReactNode;
};

/**
 * One section of an overview page (spec §5.6): the section's one Card (§1 "One box is enough"),
 * whose body is the loaded block's skeleton while loading (`aria-busy`), the in-place error line
 * on failure (the sentence with the raw text behind 原始错误, and 重试 for this section alone), or
 * the content. Each section owns its state, so one failing read never blanks the page.
 */
export function OverviewSection({
  title,
  actions,
  state,
  loading,
  error,
  children,
}: OverviewSectionProps) {
  const t = useDesignT();
  let body: ReactNode;
  if (state === "loading") {
    body = (
      <SkeletonGroup label={title}>
        <LoadingBlocks blocks={loading ?? DEFAULT_LOADING} />
      </SkeletonGroup>
    );
  } else if (state === "error") {
    body = (
      <div
        className="cb-load-failed cb-overview-section-error"
        data-part="overview-section-error"
        role="alert"
      >
        <ErrorDetail
          summary={error?.summary ?? t("overviewSection.failed")}
          {...(error?.detail !== undefined ? { detail: error.detail } : {})}
        />
        {error ? (
          <button
            type="button"
            className="cb-link-btn"
            data-part="overview-section-retry"
            onClick={() => error.onRetry()}
          >
            <Icon name="refresh" size={12} />
            {t("overviewSection.retry")}
          </button>
        ) : null}
      </div>
    );
  } else {
    body = children;
  }
  return (
    <CardFrame
      title={title}
      actions={actions}
      part="overview-section"
      state={state === "ready" ? undefined : state}
    >
      {body}
    </CardFrame>
  );
}
