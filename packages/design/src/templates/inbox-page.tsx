import type { ReactNode } from "react";
import { EmptyState, type EmptyStateProps, SkeletonGroup, SkeletonText } from "../display/index";
import { ListDetail, type ListDetailFact, ListDetailItem } from "../layout/list-detail";
import { useDesignT } from "../provider";
import { ActionRow, type ActionRowProps, Body, type PageHeaderProps } from "../shell/index";
import {
  LoadingCards,
  LoadingInspector,
  loadingActionRow,
  loadingHeader,
  TemplateHead,
} from "./frame";

/** The inbox's two panes: a 320 list beside a detail of at least 360 (spec §5.7, §6.47). */
const LIST_MIN = 320;
const DETAIL_MIN = 360;

/** 64 px rows a loading inbox draws when it is not told how many (spec §5.7). */
const LOADING_ROWS = 4;

/**
 * A loading inbox's list: `rows` rows in the ListDetailList's own row box (spec §6.47): the dot
 * slot, a `body` title slot over a `small` meta slot, a time slot at the end.
 */
function LoadingList({ rows = LOADING_ROWS }: { rows?: number | undefined }) {
  return (
    <ul className="cb-ld-list" data-part="loading-list">
      {Array.from({ length: Math.max(0, rows) }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the placeholders are positional
        <li key={i}>
          <span className="cb-ld-row" data-part="loading-row">
            <span className="cb-ld-dot" aria-hidden="true" />
            <span className="cb-ld-text">
              <SkeletonText width="55%" />
              <SkeletonText width="30%" size="small" />
            </span>
            <span className="cb-ld-time">
              <SkeletonText width={32} size="small" />
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * What `InboxPage.loading` takes: `rows` list rows (default 4) and `facts`, which draws the open
 * item's facts as placeholders (`rows`, `keyWidth`) for a page whose loaded state opens its first
 * item.
 */
export type InboxLoading = {
  rows?: number;
  facts?: boolean | { rows?: number; keyWidth?: string };
};

type InboxPageProps = {
  header: PageHeaderProps;
  /** The rail's filters, above the list; static, so they stay real while loading. */
  filters?: ReactNode;
  /** The open item's title (`h2`) and the status mark beside it (spec §6.47). */
  title?: string;
  status?: ReactNode;
  /** The open item's facts: translated labels, a tool key's value mono (spec §6.47). */
  facts?: ListDetailFact[];
  /** The facts block's accessible name. */
  factsLabel?: string;
  /** What belongs with the facts under them (a link to the conversation). */
  aside?: ReactNode;
  /** The decision row, pinned at the bottom of the open item's pane. */
  actionRow?: ActionRowProps;
  /**
   * Whether an item is open (spec §6.47). In the two-level stack (compact, or too narrow for the
   * 320 list beside a 360 detail) the list is the page until it is true; two panes always show
   * the detail. Default false.
   */
  open?: boolean;
  /** The stack's back: the page closes the open item (sets `open` false). */
  onBack?: () => void;
  empty?: EmptyStateProps;
  /** The open item's content, after its facts. */
  children?: ReactNode;
} & ({ loading?: undefined; list: ReactNode } | { loading: InboxLoading; list?: ReactNode });

/**
 * T6 Inbox (spec §5.7): the list (a `ListDetailList`, the filters above it) beside the open item,
 * a `ListDetailItem` (its title, facts, content and the decision ActionRow at the pane's bottom),
 * in one `ListDetail`. The split is capped at the content width like every page (spec §4.3), so
 * the head and the body share one left edge. `empty` (no items, a failed load) draws one
 * EmptyState instead of the split. `loading` draws the frame while the data is on the way: the
 * filters stay real (they are static), the list is `rows` 64 px row placeholders, the content a
 * card-shaped block, `loading.facts` the facts as placeholders, and a decision `actionRow` the
 * page passes (its labels are static) stays with its buttons disabled.
 */
export function InboxPage({
  header,
  list,
  filters,
  title,
  status,
  facts,
  factsLabel,
  aside,
  actionRow,
  open = false,
  onBack,
  empty,
  loading,
  children,
}: InboxPageProps) {
  const t = useDesignT();
  const shape = loading?.facts;
  const rail = loading ? (
    <>
      {filters}
      <LoadingList rows={loading.rows} />
    </>
  ) : filters != null ? (
    <>
      {filters}
      {list}
    </>
  ) : (
    list
  );
  if (empty && !loading) {
    return (
      <div className="cb-template" data-template="InboxPage" data-width="content">
        <TemplateHead header={header} statsInHead />
        <Body layout="single" width="content">
          <EmptyState {...empty} />
        </Body>
      </div>
    );
  }
  const detail = (
    <ListDetailItem
      title={loading ? undefined : title}
      status={loading ? undefined : status}
      facts={loading ? [] : (facts ?? [])}
      factsLabel={factsLabel}
      aside={
        shape ? (
          <LoadingInspector variant="facts" {...(typeof shape === "object" ? shape : {})} />
        ) : loading ? undefined : (
          aside
        )
      }
      actions={
        actionRow ? (
          <ActionRow {...(loading ? loadingActionRow(actionRow) : actionRow)} />
        ) : undefined
      }
    >
      {loading ? <LoadingCards count={1} /> : children}
    </ListDetailItem>
  );
  const page = (
    <>
      <TemplateHead header={loading ? loadingHeader(header) : header} statsInHead />
      <div className="cb-inbox-frame" data-part="inbox-frame">
        <div className="cb-inbox-content" data-part="content" data-width="content">
          <ListDetail
            list={
              <div className="cb-inbox-rail" data-part="rail">
                {rail}
              </div>
            }
            detail={open && !loading ? detail : null}
            preview={detail}
            onBack={onBack ?? (() => {})}
            listMin={LIST_MIN}
            detailMin={DETAIL_MIN}
            label={header.title || t("table.loading")}
          />
        </div>
      </div>
    </>
  );
  return (
    <div className="cb-template" data-template="InboxPage" data-width="content">
      {loading ? (
        <SkeletonGroup label={header.title || t("table.loading")}>{page}</SkeletonGroup>
      ) : (
        page
      )}
    </div>
  );
}
