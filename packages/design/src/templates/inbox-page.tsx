import type { ReactNode } from "react";
import { IconButton } from "../controls/index";
import {
  EmptyState,
  type EmptyStateProps,
  SkeletonBox,
  SkeletonGroup,
  SkeletonText,
} from "../display/index";
import { Icon } from "../icons/icon";
import { ListDetail } from "../layout/list-detail";
import { useDesignT } from "../provider";
import { ActionRow, type ActionRowProps, Body, type PageHeaderProps } from "../shell/index";
import { type Column, DataTable } from "../table/index";
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

/** One inbox row as placeholders: the object row's box, a mark and two text lines. */
function LoadingRow() {
  return (
    <li className="cb-object-row" data-part="loading-row">
      <SkeletonBox part="mark" />
      <span className="cb-object-text">
        <SkeletonText width="55%" />
        <SkeletonText width="30%" size="small" />
      </span>
    </li>
  );
}

/**
 * What `InboxPage.loading` takes: object rows (default), or the table shape of a records list;
 * `inspector` draws the selected item's inspector as KeyValue placeholders (`rows`, `keyWidth`),
 * for a page whose loaded state opens its first item (the rail-inspector layout).
 */
export type InboxLoading = (
  | { list?: "objects"; rows?: number }
  | {
      list: "records";
      /** The caller's table shape: its label, header columns and the DataTable's row height and frame. */
      table: {
        label: string;
        columns: Column<never>[];
        rowHeight?: "dense" | "default" | "roomy";
        framed?: boolean;
      };
    }
) & { inspector?: boolean | { rows?: number; keyWidth?: string } };

type InboxPageProps = {
  header: PageHeaderProps;
  /** The rail's filters, above the list; static, so they stay real while loading. */
  filters?: ReactNode;
  inspector?: ReactNode;
  inspectorTitle?: string;
  onInspectorClose?: () => void;
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
  children?: ReactNode;
} & ({ loading?: undefined; list: ReactNode } | { loading: InboxLoading; list?: ReactNode });

/**
 * The open item: its content, and its facts (the inspector) as a 400 column beside it while the
 * region has room (expanded) or below it (CSS, a container query on the region): the facts are
 * always inline, never in a sheet, so the decision they belong to is whole on one page.
 */
function InboxDetail({
  inspector,
  inspectorTitle,
  onInspectorClose,
  children,
}: {
  inspector: ReactNode;
  inspectorTitle: string | undefined;
  onInspectorClose: (() => void) | undefined;
  children: ReactNode;
}) {
  const t = useDesignT();
  return (
    <div
      className="cb-inbox-detail"
      data-part="inbox-detail"
      data-facts={inspector != null ? "true" : undefined}
    >
      <div className="cb-inbox-main" data-part="inbox-main">
        {children}
      </div>
      {inspector != null ? (
        <aside
          className="cb-inbox-facts"
          data-part="inbox-facts"
          {...(inspectorTitle !== undefined ? { "aria-label": inspectorTitle } : {})}
        >
          {onInspectorClose ? (
            <IconButton
              label={t("shell.inspectorClose")}
              icon={<Icon name="x" />}
              density="default"
              onClick={onInspectorClose}
            />
          ) : null}
          {inspector}
        </aside>
      ) : null}
    </div>
  );
}

function LoadingList({ loading }: { loading: InboxLoading }) {
  if (loading.list === "records") {
    const { label, columns, rowHeight, framed } = loading.table;
    return (
      <DataTable<never>
        label={label}
        state="loading"
        columns={columns}
        rows={[]}
        rowKey={() => ""}
        {...(rowHeight ? { rowHeight } : {})}
        {...(framed !== undefined ? { framed } : {})}
      />
    );
  }
  // The loaded ObjectList's own container, so the border, radius and first row are the same.
  return (
    <ul className="cb-object-list" data-part="loading-list">
      {Array.from({ length: loading.rows ?? LOADING_ROWS }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the placeholders are positional
        <LoadingRow key={i} />
      ))}
    </ul>
  );
}

/**
 * T6 Inbox: Rail (the list) + Content (+ Inspector); an ActionRow while deciding. The split is
 * capped at the content width like every page (spec §4.3), so the head and the body share one left
 * edge. `empty` (no items, a failed load) draws one EmptyState instead of the list + detail split.
 * `filters` sit at the top of the rail, above `list`. `loading` draws the frame while the data is
 * on the way (spec §5.7): the filters stay real (they are static), the list is `rows` 64 px rows
 * (default 4) in the object list's own container in place of `list` (`loading.list: "records"`
 * draws the DataTable's loading state in the caller's table shape instead), the content is a
 * card-shaped block in place of `children`, and a real `inspector` stays. A page whose loaded state
 * opens its first item passes `loading.inspector` (KeyValue placeholders in the inspector column)
 * and its decision `actionRow` (the labels are static), which stays with its buttons disabled.
 */
export function InboxPage({
  header,
  list,
  filters,
  inspector,
  inspectorTitle,
  onInspectorClose,
  actionRow,
  open = false,
  onBack,
  empty,
  loading,
  children,
}: InboxPageProps) {
  const t = useDesignT();
  const shape = loading?.inspector;
  const inspectorNode = shape ? (
    <LoadingInspector {...(typeof shape === "object" ? shape : {})} />
  ) : (
    inspector
  );
  const rail = loading ? (
    <>
      {filters}
      <LoadingList loading={loading} />
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
    <InboxDetail
      inspector={inspectorNode}
      inspectorTitle={inspectorTitle}
      onInspectorClose={onInspectorClose}
    >
      {loading ? <LoadingCards count={1} /> : children}
    </InboxDetail>
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
            footer={
              actionRow ? (
                <ActionRow {...(loading ? loadingActionRow(actionRow) : actionRow)} />
              ) : undefined
            }
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
