import { isValidElement, type ReactNode } from "react";
import {
  Callout,
  type CalloutProps,
  EmptyState,
  type EmptyStateProps,
  ObjectList,
  Skeleton,
  SkeletonGroup,
} from "../display/index";
import { useDesignT } from "../provider";
import { ActionRow, type ActionRowProps, Body, type PageHeaderProps } from "../shell/index";
import { type Column, DataTable } from "../table/index";
import { LoadingStats, loadingActionRow, loadingHeader, TemplateHead, WithStats } from "./frame";

/**
 * What `ListPage.loading` takes besides `true`: `rows` (objects: the row count, default 3), `stats`
 * (stat card placeholders when the header carries no `metrics` yet), and, for a `records` list,
 * `table`: the caller's table shape (label, header columns, row height and frame), drawn as the
 * DataTable's own loading state instead of plain bars.
 */
export type ListLoading =
  | boolean
  | {
      rows?: number;
      stats?: number;
      /**
       * The children are the page's own sections, each saying for itself whether it is loading:
       * they render as they are, inside the page's one busy region (no section announces itself).
       */
      keep?: boolean;
      table?: {
        label: string;
        columns: Column<never>[];
        rowHeight?: "dense" | "default" | "roomy";
        framed?: boolean;
      };
    };

/**
 * T2 List: Rail + Content (Single without a rail), list width; StatCards from `metrics`.
 * `variant="objects"` wraps the children (ObjectRows) in one ObjectList panel; `records` (default)
 * leaves them to the caller (a DataTable). `callout` is drawn between the title row and the tabs;
 * `empty` is drawn instead of the children. `loading` draws the page's frame while the first answer
 * is on the way (spec §5.1): the header keeps its rows (an unknown title is a bar), its tabs show a
 * dash for their counts, stat slots stand in for unknown metrics, and the list is skeleton rows in the
 * loaded list's own container (objects: the ObjectList panel; records: the DataTable's loading
 * state in the caller's `table` shape, else plain bars), instead of the children or `empty`. One
 * busy announcement.
 *
 * One primary per screen (spec §5.2): while `empty` is drawn with a primary action, the head's
 * primary is left out and the empty state carries it.
 */
export function ListPage({
  header,
  rail,
  actionRow,
  variant = "records",
  listLabel,
  callout,
  empty,
  loading: loadingProp = false,
  filters,
  children,
}: {
  header: PageHeaderProps;
  rail?: ReactNode;
  actionRow?: ActionRowProps;
  variant?: "objects" | "records";
  /** The accessible name of the object list (default: the page title). */
  listLabel?: string;
  callout?: CalloutProps;
  empty?: EmptyStateProps;
  /** The list's first answer is still loading (see {@link ListLoading}). */
  loading?: ListLoading;
  /**
   * A second row of view tabs above the list, when the head's tab row already holds the page's
   * views (the marketplace entries' sources). Kept while loading.
   */
  filters?: ReactNode;
  children?: ReactNode;
}) {
  const t = useDesignT();
  const loading = loadingProp !== false;
  const spec = typeof loadingProp === "object" ? loadingProp : {};
  // While loading the head keeps its real layout: the tabs stay (a tab that counts shows a muted
  // dash) and so does the search; only the data region shows skeleton rows.
  const withTabs =
    loading && header.tabs
      ? {
          ...header,
          tabs: header.tabs.map((tab) =>
            tab.count !== undefined ? { ...tab, pending: true } : tab,
          ),
        }
      : header;
  const emptyPrimary =
    !loading &&
    empty?.action !== undefined &&
    !isValidElement(empty.action) &&
    "variant" in empty.action &&
    empty.action.variant === "primary";
  const onePrimary =
    emptyPrimary && withTabs.actions
      ? {
          ...withTabs,
          actions: withTabs.actions.filter((a) => !("variant" in a && a.variant === "primary")),
        }
      : withTabs;
  const head = callout ? { ...onePrimary, notice: <Callout {...callout} /> } : onePrimary;
  const loadingList =
    variant === "objects" ? (
      <ObjectList label={listLabel ?? header.title} loading={spec.rows ?? true} />
    ) : spec.table ? (
      <DataTable<never>
        label={spec.table.label}
        state="loading"
        columns={spec.table.columns}
        rows={[]}
        rowKey={() => ""}
        {...(spec.table.rowHeight ? { rowHeight: spec.table.rowHeight } : {})}
        {...(spec.table.framed !== undefined ? { framed: spec.table.framed } : {})}
      />
    ) : (
      <Skeleton rows={4} />
    );
  const content = loading ? (
    spec.keep ? (
      children
    ) : (
      loadingList
    )
  ) : empty ? (
    <EmptyState {...empty} />
  ) : variant === "objects" ? (
    <ObjectList label={listLabel ?? header.title}>{children}</ObjectList>
  ) : (
    children
  );
  const slots = loading && (header.metrics ?? []).length === 0 ? (spec.stats ?? 0) : 0;
  const page = (
    <>
      <TemplateHead header={loading ? loadingHeader(head) : head} />
      <Body layout={rail != null ? "rail" : "single"} rail={rail} width="content">
        <WithStats header={header}>
          <LoadingStats count={slots} />
          {filters ? <div className="cb-list-filters">{filters}</div> : null}
          {content}
        </WithStats>
      </Body>
      {actionRow ? <ActionRow {...(loading ? loadingActionRow(actionRow) : actionRow)} /> : null}
    </>
  );
  return (
    <div className="cb-template" data-template="ListPage" data-width="content">
      <SkeletonGroup label={header.title || t("table.loading")} active={loading}>
        {page}
      </SkeletonGroup>
    </div>
  );
}
