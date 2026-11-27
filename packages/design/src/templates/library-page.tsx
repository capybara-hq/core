import {
  isValidElement,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Button, IconButton } from "../controls/index";
import {
  EmptyState,
  type EmptyStateProps,
  Segmented,
  SkeletonGroup,
  SkeletonText,
} from "../display/index";
import { Icon } from "../icons/icon";
import type { IconName } from "../icons/paths";
import { BoxScope } from "../layout/box";
import { ListDetail } from "../layout/list-detail";
import { BottomSheet, Menu, type MenuItem, Sheet } from "../overlays/index";
import { useDesignT } from "../provider";
import {
  ClassForms,
  type HeaderAction,
  type PageHeaderProps,
  useClassForm,
  useRegisterShellPage,
} from "../shell/index";
import { HeadSearch } from "../shell/page-header";
import { loadingHeader, TemplateHead } from "./frame";

/** The library's two panes: a 320 list beside a preview of at least 360 (spec §5.13, §6.47). */
const LIST_MIN = 320;
const DETAIL_MIN = 360;
const FIT = LIST_MIN + DETAIL_MIN;

/** Rows a loading library draws when it is not told how many. */
const LOADING_ROWS = 6;

/**
 * One action on the open file (spec §5.13): a button (`onSelect`) or a link (`href`; `download`
 * makes it a download). `menu` sends it to the `more-horizontal` menu instead of a button of its
 * own (a destructive action such as delete goes there, `danger`). None is accented: the head's
 * upload is the screen's one primary (spec §5.2).
 */
export type LibraryAction = {
  id: string;
  label: string;
  icon: IconName;
  onSelect?: () => void;
  href?: string;
  download?: boolean;
  menu?: boolean;
  danger?: boolean;
};

/** What `LibraryPage.loading` takes besides `true`: `rows` list rows (default 6). */
export type LibraryLoading = boolean | { rows?: number };

export type LibraryPageProps = {
  /**
   * The head: `path`, `title`, the origin views as `tabs` (all / delivered by agents / my uploads, each with
   * `onSelect`; `activeTab`) and the `search`. From 600 the head draws the tabs and the search in
   * its tab row; below 600 the tabs are a full-width Segmented and the search an icon that expands.
   */
  header: PageHeaderProps;
  /** The head's actions (the upload, `variant: "primary"`): added after `header.actions`. */
  actions?: HeaderAction[];
  /** Field filters (the agent and type Selects): a row above the panes from 600, the Filter sheet below. */
  filters?: ReactNode;
  /** How many `filters` are active: the count on the compact Filter button. */
  filterCount?: number;
  /** One `small` `muted` line under the list (the storage used), already localized. */
  usage?: string;
  /** The list: a `ListDetailList`, usually with `groups` (today / this week / earlier) and `current`. */
  list: ReactNode;
  /**
   * The selected file's content (the preview frame and its details), or `null` with nothing
   * selected. The template draws its title and `detailActions` above it, so the page passes no
   * action row of its own.
   */
  detail: ReactNode | null;
  /** The selected file's name: the detail's heading and the side sheet's title. */
  detailTitle?: string | undefined;
  /** The actions on the selected file (share, download, more). */
  detailActions?: LibraryAction[];
  /** What the preview pane shows in two panes while nothing is selected (a `panel` EmptyState). */
  detailEmpty?: EmptyStateProps;
  /**
   * The detail is shown where it is not beside the list: pushed over the list below 600, in the
   * side sheet when two panes do not fit from 600. Two panes show `detail` whether or not it is
   * open. Default false.
   */
  open?: boolean;
  /**
   * Closes the shown detail (the shell's back below 600, the sheet's close from 600): the page sets
   * `open` false and keeps the selection, so the row stays the current one.
   */
  onBack(): void;
  /** No files (or none match): one EmptyState in place of the panes; the head and filters stay. */
  empty?: EmptyStateProps;
  /** The first answer is on its way (see {@link LibraryLoading}). */
  loading?: LibraryLoading;
};

/**
 * Whether the region is wide enough for both panes (`listMin + detailMin`): the same line the
 * ListDetail container query draws (`max-width: 679px` stacks, so a fractional 679.5 still fits),
 * read for the side sheet, which CSS cannot open. A region that has no width yet (not laid out)
 * counts as fitting, as the first paint does.
 */
function useFits(el: HTMLElement | null): boolean {
  const [fits, setFits] = useState(true);
  useLayoutEffect(() => {
    if (!el) return;
    const read = () => {
      const w = el.getBoundingClientRect().width;
      setFits(w === 0 || w > FIT - 1);
    };
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return fits;
}

/** A loading list: `rows` rows in the ListDetailList's own row box (the icon slot, two text slots). */
function LoadingRows({ rows }: { rows: number }) {
  return (
    <ul className="cb-ld-list" data-part="loading-list">
      {Array.from({ length: Math.max(0, rows) }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the placeholders are positional
        <li key={i}>
          <span className="cb-ld-row" data-part="loading-row">
            <span className="cb-ld-icon" aria-hidden="true" />
            <span className="cb-ld-text">
              <SkeletonText width="55%" />
              <SkeletonText width="30%" size="small" />
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Follows a download link the way a `download` anchor does (a menu item is no anchor). */
function download(href: string): void {
  const a = document.createElement("a");
  a.href = href;
  a.download = "";
  a.rel = "noopener";
  document.body.append(a);
  a.click();
  a.remove();
}

function menuItem(a: LibraryAction): MenuItem {
  const base = { label: a.label, icon: a.icon, ...(a.danger ? { danger: true } : {}) };
  const href = a.href;
  if (href === undefined) return { ...base, onSelect: () => a.onSelect?.() };
  return a.download ? { ...base, onSelect: () => download(href) } : { ...base, href };
}

/**
 * The detail's actions: from 600 buttons with their labels, below 600 icon
 * buttons (the compact top bar: share, download); `menu` actions in one `more-horizontal` menu.
 */
function DetailActions({ actions, form }: { actions: LibraryAction[]; form: "compact" | "wide" }) {
  const t = useDesignT();
  const own = actions.filter((a) => !a.menu);
  const items = actions.filter((a) => a.menu).map(menuItem);
  const compact = form === "compact";
  const one = (a: LibraryAction) => {
    if (a.href !== undefined) {
      return compact ? (
        <a
          key={a.id}
          href={a.href}
          {...(a.download ? { download: "" } : {})}
          className="cb-btn cb-icon-btn"
          data-part="icon-button"
          data-variant="ghost"
          aria-label={a.label}
          title={a.label}
        >
          <Icon name={a.icon} />
        </a>
      ) : (
        <a
          key={a.id}
          href={a.href}
          {...(a.download ? { download: "" } : {})}
          className="cb-btn cb-btn-link cb-btn-link-default"
          data-part="button"
          data-variant="default"
        >
          <span className="cb-btn-body">
            <Icon name={a.icon} size={14} />
            {a.label}
          </span>
        </a>
      );
    }
    return compact ? (
      <IconButton
        key={a.id}
        label={a.label}
        icon={<Icon name={a.icon} />}
        {...(a.onSelect ? { onClick: a.onSelect } : {})}
      />
    ) : (
      <Button key={a.id} variant="default" {...(a.onSelect ? { onClick: a.onSelect } : {})}>
        <Icon name={a.icon} size={14} />
        {a.label}
      </Button>
    );
  };
  return (
    <div className="cb-library-actions" data-part="library-detail-actions">
      {own.map(one)}
      {items.length > 0 ? (
        <Menu
          items={items}
          trigger={
            <IconButton
              label={t("shell.moreActions")}
              icon={<Icon name="more-horizontal" />}
              variant={compact ? "ghost" : "default"}
            />
          }
        />
      ) : null}
    </div>
  );
}

/** The compact search: an icon that expands into the field (it stays open while it holds text). */
function CompactSearch({ search }: { search: NonNullable<PageHeaderProps["search"]> }) {
  const t = useDesignT();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const shown = open || search.value !== "";
  useEffect(() => {
    if (open) box.current?.querySelector("input")?.focus();
  }, [open]);
  if (!shown) {
    return (
      <IconButton
        label={search.label}
        icon={<Icon name="search" />}
        aria-expanded={false}
        onClick={() => setOpen(true)}
      />
    );
  }
  return (
    <div ref={box} className="cb-library-compact-search" data-part="library-compact-search">
      <HeadSearch search={search} />
      <IconButton
        label={t("overlay.close")}
        icon={<Icon name="x" />}
        onClick={() => {
          search.onChange("");
          setOpen(false);
        }}
      />
    </div>
  );
}

/**
 * T15 Library (spec §5.13): the person's files, a list beside a preview. The head carries the
 * origin views (`header.tabs`), the search and the upload (`actions`); the field `filters` stand in
 * a row above the panes; the list (a `ListDetailList`, grouped by time) and the selected file's
 * preview with its details are one `ListDetail` (list 320, preview at least 360), each pane its own
 * card from 600; `usage` is a line under the list. `empty` draws one EmptyState in place of the
 * panes (the head and the filters stay, so a filter can be undone); `loading` keeps the head and
 * the filters and draws placeholder rows and a placeholder preview.
 *
 * Classes (mobile layout spec §5.1, §5.2; the template decides, never the page):
 * - **expanded** and **medium** (from 600): two panes while the region fits both; otherwise the
 *   list fills it and the open file (`open`) shows in a side `Sheet` (draggable, its actions in the
 *   footer), whose close calls `onBack` with the row still the current one.
 * - **compact** (below 600): a pushed page; the head drops its path, the upload is the floating
 *   action button, the origin views a full-width Segmented, the search an icon that expands and the
 *   filters one Filter bottom sheet; rows take the grouped look. An open file is its own screen: the
 *   head and the bar give way, the shell's floating back calls `onBack` (registered by the
 *   ListDetail), and a top bar holds the file's name and its actions as icon buttons and a menu.
 */
export function LibraryPage({
  header,
  actions,
  filters,
  filterCount,
  usage,
  list,
  detail,
  detailTitle,
  detailActions = [],
  detailEmpty,
  open = false,
  onBack,
  empty,
  loading: loadingProp = false,
}: LibraryPageProps) {
  const t = useDesignT();
  const form = useClassForm();
  const [split, setSplit] = useState<HTMLDivElement | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const fits = useFits(split);
  const loading = loadingProp !== false;
  const rows = typeof loadingProp === "object" ? (loadingProp.rows ?? LOADING_ROWS) : LOADING_ROWS;
  const hasFilters = filters != null && filters !== false;
  const shownDetail = loading ? null : detail;
  // The side sheet stands in for the second pane from 600 when the region cannot hold both.
  const sheet = form === "wide" && !fits;
  const pushed = open && shownDetail !== null && !sheet;

  // The head: the upload joins the header's actions; a loading head marks its counted tabs pending.
  const merged: PageHeaderProps = {
    ...header,
    ...(actions || header.actions
      ? { actions: [...(header.actions ?? []), ...(actions ?? [])] }
      : {}),
  };
  const emptyPrimary =
    !loading &&
    empty?.action !== undefined &&
    !isValidElement(empty.action) &&
    "variant" in empty.action &&
    empty.action.variant === "primary";
  const onePrimary: PageHeaderProps =
    emptyPrimary && merged.actions
      ? {
          ...merged,
          actions: merged.actions.filter((a) => !("variant" in a && a.variant === "primary")),
        }
      : merged;
  const head: PageHeaderProps =
    loading && onePrimary.tabs
      ? {
          ...onePrimary,
          tabs: onePrimary.tabs.map((tab) =>
            tab.count !== undefined ? { ...tab, pending: true } : tab,
          ),
        }
      : onePrimary;
  // The head's primary is the strip pill's on compact (interaction model §10.3, D10), as on a list.
  const primaryAction = (head.actions ?? []).find(
    (a): a is Extract<HeaderAction, { variant: string }> =>
      "variant" in a && a.variant === "primary",
  );
  useRegisterShellPage({
    ...(primaryAction && !primaryAction.disabled && !primaryAction.loading
      ? {
          primary: {
            id: "library-primary",
            label: primaryAction.label,
            icon: "plus",
            ...(primaryAction.href !== undefined
              ? { href: primaryAction.href }
              : { run: () => primaryAction.onSelect?.() }),
          },
        }
      : {}),
  });
  const fab = primaryAction !== undefined;

  // Compact: the head gives its tabs and search to the bar under it.
  const tabItems = head.tabs ?? [];
  const search = head.search;
  const hasBar = tabItems.length > 0 || search !== undefined || hasFilters;
  const compactHead = (): PageHeaderProps => {
    const { tabs: _t, search: _s, activeTab: _a, ...rest } = head;
    return rest;
  };
  const shownHead = form === "compact" && hasBar ? compactHead() : head;
  const compactBar = hasBar ? (
    <div className="cb-library-compact-bar" data-part="library-compact-bar">
      {tabItems.length > 0 ? (
        <Segmented
          fill
          label={t("shell.pageViews")}
          value={head.activeTab ?? tabItems[0]?.id ?? ""}
          onChange={(id) => tabItems.find((x) => x.id === id)?.onSelect?.()}
          options={tabItems.map((x) => ({
            value: x.id,
            label: x.count !== undefined && !x.pending ? `${x.label} ${x.count}` : x.label,
          }))}
        />
      ) : null}
      {search !== undefined || hasFilters ? (
        <div className="cb-library-compact-tools" data-part="library-compact-tools">
          {search ? <CompactSearch search={search} /> : null}
          {hasFilters ? (
            <Button onClick={() => setFilterOpen(true)}>
              <Icon name="sliders" size={14} />
              {t("shell.filter")}
              {(filterCount ?? 0) > 0 ? (
                <span className="cb-body-tool-count" data-part="filter-count">
                  <span aria-hidden="true">{filterCount}</span>
                  <span className="cb-sr-only">
                    {` ${t("shell.filterActive").replace("{n}", String(filterCount))}`}
                  </span>
                </span>
              ) : null}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  ) : null;

  const listPane = (
    <div className="cb-library-list" data-part="library-list">
      <BoxScope kind="card">
        {loading ? <LoadingRows rows={rows} /> : list}
        {usage && !loading ? (
          <p className="cb-library-usage" data-part="library-usage">
            {usage}
          </p>
        ) : null}
      </BoxScope>
    </div>
  );
  const detailPane = (node: ReactNode) => (
    <div className="cb-library-detail" data-part="library-detail">
      <BoxScope kind="card">
        {detailTitle !== undefined || detailActions.length > 0 ? (
          <header className="cb-library-detail-head" data-part="library-detail-head">
            {detailTitle !== undefined ? (
              <h2 className="cb-library-detail-title" title={detailTitle}>
                {detailTitle}
              </h2>
            ) : null}
            {detailActions.length > 0 ? (
              <ClassForms
                compact={<DetailActions actions={detailActions} form="compact" />}
                wide={<DetailActions actions={detailActions} form="wide" />}
              />
            ) : null}
          </header>
        ) : null}
        <div className="cb-library-detail-body" data-part="library-detail-body">
          {node}
        </div>
      </BoxScope>
    </div>
  );
  const placeholder = loading ? (
    <div className="cb-library-detail" data-part="library-detail">
      <BoxScope kind="card">
        <div className="cb-library-detail-body" data-part="library-detail-body">
          {/* placeholder lines on the pane's own ground: the pane is the one box */}
          <div className="cb-loading-stack" data-part="loading-preview">
            <SkeletonText width="30%" />
            <SkeletonText width="100%" />
            <SkeletonText width="70%" />
            <SkeletonText width="55%" />
          </div>
        </div>
      </BoxScope>
    </div>
  ) : detailEmpty ? (
    <div className="cb-library-detail" data-part="library-detail">
      <BoxScope kind="card">
        <div className="cb-library-detail-body" data-part="library-detail-body">
          <EmptyState {...detailEmpty} size="panel" />
        </div>
      </BoxScope>
    </div>
  ) : null;
  const opened = shownDetail !== null ? detailPane(shownDetail) : null;
  // The selected file stands in the second pane only while two panes show (from 600, fitting):
  // in the stack (compact, or the side-sheet form) the pane is hidden, and a preview mounted
  // there would load a second time (an extra HTML token or embed) or load unseen. Before
  // hydration the class is unknown, so nothing is mounted there until it is.
  const twoPanes = form === "wide" && fits;

  const page = (
    <>
      {/* box-less (display: contents); an open file's own screen hides it below 600 */}
      <div className="cb-library-top" data-part="library-top">
        <TemplateHead header={loading ? loadingHeader(shownHead) : shownHead} primaryForm="fab" />
        {hasBar ? <ClassForms compact={compactBar} wide={null} /> : null}
      </div>
      <div className="cb-library-frame" data-part="library-frame">
        <div className="cb-library-content" data-part="content" data-width="content">
          {hasFilters ? (
            <ClassForms
              compact={null}
              wide={
                <div className="cb-library-filters" data-part="library-filters">
                  {filters}
                </div>
              }
            />
          ) : null}
          {empty && !loading ? (
            <EmptyState {...empty} />
          ) : (
            <div ref={setSplit} className="cb-library-split" data-part="library-split">
              <ListDetail
                list={listPane}
                detail={pushed ? opened : null}
                preview={twoPanes ? (opened ?? placeholder) : null}
                onBack={onBack}
                listMin={LIST_MIN}
                detailMin={DETAIL_MIN}
                label={header.title || t("table.loading")}
              />
            </div>
          )}
        </div>
      </div>
    </>
  );

  return (
    <div
      className="cb-template"
      data-template="LibraryPage"
      data-width="content"
      data-open={pushed ? "true" : undefined}
      data-fab={fab ? "true" : undefined}
    >
      <SkeletonGroup label={header.title || t("table.loading")} active={loading}>
        {page}
      </SkeletonGroup>
      {form === "compact" && hasFilters ? (
        <BottomSheet
          open={filterOpen}
          onOpenChange={setFilterOpen}
          title={t("shell.filter")}
          part="filter-sheet"
        >
          <div className="cb-body-filter-fields">{filters}</div>
        </BottomSheet>
      ) : null}
      {sheet ? (
        <Sheet
          open={open && shownDetail !== null}
          onOpenChange={(o) => {
            if (!o) onBack();
          }}
          title={detailTitle ?? header.title}
          draggable
          {...(detailActions.length > 0
            ? { footer: <DetailActions actions={detailActions} form="wide" /> }
            : {})}
        >
          {shownDetail}
        </Sheet>
      ) : null}
    </div>
  );
}
