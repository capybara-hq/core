import type { ReactNode } from "react";
import {
  Callout,
  type CalloutProps,
  EmptyState,
  type EmptyStateProps,
  ObjectList,
  Skeleton,
} from "../display/index";
import { ActionRow, type ActionRowProps, Body, type PageHeaderProps } from "../shell/index";
import { TemplateHead, WithStats } from "./frame";

/**
 * T2 List: Rail + Content (Single without a rail), list width; StatCards from `metrics`.
 * `variant="objects"` wraps the children (ObjectRows) in one ObjectList panel; `records` (default)
 * leaves them to the caller (a DataTable). `callout` is drawn between the title row and the tabs;
 * `empty` is drawn instead of the children. `loading` draws skeleton rows (objects: in the 64 px
 * row shape inside the panel; records: a Skeleton) instead of the children or `empty`; the head,
 * its tabs (counts pending) and its search keep their place.
 */
export function ListPage({
  header,
  rail,
  actionRow,
  variant = "records",
  listLabel,
  callout,
  empty,
  loading = false,
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
  /** The list's first answer is still loading. */
  loading?: boolean;
  /**
   * A second row of view tabs above the list, when the head's tab row already holds the page's
   * views (the marketplace entries' sources). Kept while loading.
   */
  filters?: ReactNode;
  children?: ReactNode;
}) {
  // While loading the head keeps its real layout: the tabs stay (a tab that counts shows a muted
  // dash) and so does the search; only the data region shows skeleton rows.
  const withTabs =
    loading && header.tabs
      ? {
          ...header,
          tabs: header.tabs.map((t) => (t.count !== undefined ? { ...t, pending: true } : t)),
        }
      : header;
  const head = callout ? { ...withTabs, notice: <Callout {...callout} /> } : withTabs;
  const content = loading ? (
    variant === "objects" ? (
      <ObjectList label={listLabel ?? header.title} loading />
    ) : (
      <Skeleton rows={4} />
    )
  ) : empty ? (
    <EmptyState {...empty} />
  ) : variant === "objects" ? (
    <ObjectList label={listLabel ?? header.title}>{children}</ObjectList>
  ) : (
    children
  );
  return (
    <div className="cb-template" data-template="ListPage" data-width="content">
      <TemplateHead header={head} />
      <Body layout={rail != null ? "rail" : "single"} rail={rail} width="content">
        <WithStats header={header}>
          {filters ? <div className="cb-list-filters">{filters}</div> : null}
          {content}
        </WithStats>
      </Body>
      {actionRow ? <ActionRow {...actionRow} /> : null}
    </div>
  );
}
