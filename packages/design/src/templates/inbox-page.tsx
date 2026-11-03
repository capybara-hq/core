import type { ReactNode } from "react";
import {
  EmptyState,
  type EmptyStateProps,
  SkeletonBox,
  SkeletonGroup,
  SkeletonText,
} from "../display/index";
import { useDesignT } from "../provider";
import { ActionRow, type ActionRowProps, Body, type PageHeaderProps } from "../shell/index";
import { LoadingCards, loadingHeader, TemplateHead } from "./frame";

/** 64 px rows a loading inbox draws when it is not told how many (spec §5.7). */
const LOADING_ROWS = 4;

/** One inbox row as placeholders: the object row's box, a mark and two text lines. */
function LoadingRow() {
  return (
    <div className="cb-object-row" data-part="loading-row">
      <SkeletonBox part="mark" />
      <span className="cb-object-text">
        <SkeletonText width="55%" />
        <SkeletonText width="30%" size="small" />
      </span>
    </div>
  );
}

/**
 * T6 Inbox: Rail (the list) + Content (+ Inspector); an ActionRow while deciding. The split is
 * capped at the content width like every page (spec §4.3), so the head and the body share one left
 * edge. `empty` (no items, a failed load) draws one EmptyState instead of the list + detail split.
 * `filters` sit at the top of the rail, above `list`. `loading` draws the frame while the data is
 * on the way (spec §5.7): the filters stay real (they are static), the list is `rows` 64 px rows
 * (default 4) in place of `list`, the content is a card-shaped block in place of `children`, and a
 * real `inspector` stays.
 */
export function InboxPage({
  header,
  list,
  filters,
  inspector,
  inspectorTitle,
  onInspectorClose,
  actionRow,
  empty,
  loading,
  children,
}: {
  header: PageHeaderProps;
  list?: ReactNode;
  filters?: ReactNode;
  inspector?: ReactNode;
  inspectorTitle?: string;
  onInspectorClose?: () => void;
  actionRow?: ActionRowProps;
  empty?: EmptyStateProps;
  loading?: { rows?: number };
  children?: ReactNode;
}) {
  const t = useDesignT();
  const rail = loading ? (
    <>
      {filters}
      {Array.from({ length: loading.rows ?? LOADING_ROWS }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the placeholders are positional
        <LoadingRow key={i} />
      ))}
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
  const page = (
    <>
      <TemplateHead header={loading ? loadingHeader(header) : header} statsInHead />
      <Body
        layout={inspector != null ? "rail-inspector" : "rail"}
        rail={rail}
        railFlush
        contentPadded
        width="content"
        inspector={inspector}
        {...(inspectorTitle !== undefined ? { inspectorTitle } : {})}
        {...(onInspectorClose ? { onInspectorClose } : {})}
      >
        {loading ? <LoadingCards count={1} /> : children}
      </Body>
      {actionRow ? <ActionRow {...actionRow} /> : null}
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
