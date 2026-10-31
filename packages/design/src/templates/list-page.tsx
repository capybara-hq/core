import type { ReactNode } from "react";
import {
  Callout,
  type CalloutProps,
  EmptyState,
  type EmptyStateProps,
  ObjectList,
} from "../display/index";
import { ActionRow, type ActionRowProps, Body, type PageHeaderProps } from "../shell/index";
import { TemplateHead, WithStats } from "./frame";

/**
 * T2 List: Rail + Content (Single without a rail), list width; StatCards from `metrics`.
 * `variant="objects"` wraps the children (ObjectRows) in one ObjectList panel; `records` (default)
 * leaves them to the caller (a DataTable). `callout` is drawn between the title row and the tabs;
 * `empty` is drawn instead of the children.
 */
export function ListPage({
  header,
  rail,
  actionRow,
  variant = "records",
  listLabel,
  callout,
  empty,
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
  children?: ReactNode;
}) {
  const head = callout ? { ...header, notice: <Callout {...callout} /> } : header;
  const content = empty ? (
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
        <WithStats header={header}>{content}</WithStats>
      </Body>
      {actionRow ? <ActionRow {...actionRow} /> : null}
    </div>
  );
}
