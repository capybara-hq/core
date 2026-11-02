import type { ReactNode } from "react";
import { EmptyState, type EmptyStateProps } from "../display/index";
import { ActionRow, type ActionRowProps, Body, type PageHeaderProps } from "../shell/index";
import { TemplateHead } from "./frame";

/**
 * T6 Inbox: Rail (the list) + Content (+ Inspector); an ActionRow while deciding. The split is
 * capped at the content width like every page (spec §4.3), so the head and the body share one left
 * edge. `empty` (no items, a failed load) draws one EmptyState instead of the list + detail split.
 */
export function InboxPage({
  header,
  list,
  inspector,
  inspectorTitle,
  onInspectorClose,
  actionRow,
  empty,
  children,
}: {
  header: PageHeaderProps;
  list: ReactNode;
  inspector?: ReactNode;
  inspectorTitle?: string;
  onInspectorClose?: () => void;
  actionRow?: ActionRowProps;
  empty?: EmptyStateProps;
  children?: ReactNode;
}) {
  if (empty) {
    return (
      <div className="cb-template" data-template="InboxPage" data-width="content">
        <TemplateHead header={header} statsInHead />
        <Body layout="single" width="content">
          <EmptyState {...empty} />
        </Body>
      </div>
    );
  }
  return (
    <div className="cb-template" data-template="InboxPage" data-width="content">
      <TemplateHead header={header} statsInHead />
      <Body
        layout={inspector != null ? "rail-inspector" : "rail"}
        rail={list}
        railFlush
        contentPadded
        width="content"
        inspector={inspector}
        {...(inspectorTitle !== undefined ? { inspectorTitle } : {})}
        {...(onInspectorClose ? { onInspectorClose } : {})}
      >
        {children}
      </Body>
      {actionRow ? <ActionRow {...actionRow} /> : null}
    </div>
  );
}
