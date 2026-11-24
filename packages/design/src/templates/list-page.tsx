import { Children, isValidElement, type ReactNode, useState } from "react";
import { Select } from "../controls/index";
import {
  Callout,
  type CalloutProps,
  CardGrid,
  EmptyState,
  type EmptyStateProps,
  type ListMoreProps,
  ObjectList,
  type ScopeChipOption,
  ScopeChips,
  Segmented,
  Skeleton,
  SkeletonGroup,
  SkeletonText,
  Tabs,
} from "../display/index";
import { useDesignT } from "../provider";
import {
  ActionRow,
  type ActionRowProps,
  Body,
  ClassForms,
  type HeaderAction,
  type PageHeaderProps,
  useClassForm,
  useRegisterShellPage,
} from "../shell/index";
import { HeadSearch } from "../shell/page-header";
import { type Column, DataTable } from "../table/index";
import {
  LoadingStats,
  loadingActionRow,
  loadingHeader,
  TemplateFrame,
  TemplateHead,
  WithStats,
} from "./frame";
import { useScrollRestore } from "./list-scroll";

/**
 * What `ListPage.loading` takes besides `true`: `rows` (objects: the row count, default 3; cards:
 * the card count, default 6), `stats`
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
 * The list's view choice (responsive system spec §2.2 level 2, §4): a subset of the set the head's
 * tabs choose. Compact draws it as scope chips in the quick-return bar, medium and expanded as a
 * Segmented above the list; both draw one Select for more than {@link SEGMENTED_MAX} options, and
 * chips whenever an option carries an avatar.
 */
export type ListScope = {
  label: string;
  value: string;
  options: ScopeChipOption[];
  onChange(value: string): void;
};

/** The most options a wide `scope` draws as a Segmented (responsive system spec §2.2). */
const SEGMENTED_MAX = 5;

/**
 * Whether a node holds a view choice (a `Segmented` or `Tabs`) in its element tree, read through
 * `props.children` only: one drawn inside another component's own render is not seen.
 */
function holdsViewChoice(node: ReactNode): boolean {
  return Children.toArray(node).some(
    (n) =>
      isValidElement<{ children?: ReactNode }>(n) &&
      (n.type === Segmented || n.type === Tabs || holdsViewChoice(n.props.children)),
  );
}

/** A view choice is `scope`, never also a Segmented / Tabs in `filters` (design spec §5.1). */
function assertScope(scope: ListScope | undefined, filters: ReactNode): void {
  if (process.env.NODE_ENV === "production" || scope === undefined) return;
  if (!holdsViewChoice(filters)) return;
  throw new Error(
    "ListPage: `scope` and a Segmented or Tabs passed through `filters` are not both given; " +
      "the view choice is `scope`, `filters` holds field filters",
  );
}

/**
 * T2 List: Rail + Content (Single without a rail), list width; StatCards from `metrics`.
 * `variant="objects"` wraps the children (ObjectRows) in one ObjectList panel; `cards` lays the
 * children (ObjectCards) out in one CardGrid on the page ground (spec §6.34); `records` (default)
 * leaves them to the caller (a DataTable). `callout` is drawn between the title row and the tabs;
 * `empty` is drawn instead of the children. `loading` draws the page's frame while the first answer
 * is on the way (spec §5.1): the header keeps its rows (an unknown title is a bar), its tabs show a
 * dash for their counts, stat slots stand in for unknown metrics, and the list is skeleton rows in the
 * loaded list's own container (objects: the ObjectList panel; cards: skeleton cards in the
 * CardGrid; records: the DataTable's loading
 * state in the caller's `table` shape, else plain bars), instead of the children or `empty`. One
 * busy announcement.
 *
 * One primary per screen (spec §5.2): while `empty` is drawn with a primary action, the head's
 * primary is left out and the empty state carries it.
 *
 * Compact (below 600; responsive system spec §3.1, §2.6, §5.4; design spec §5.1, §6.65): the
 * template root is the page's one scroller (`TemplateFrame`). The head is the compact head with
 * its primary as the floating action button (`primaryForm="fab"`, the `data-fab` CSS form, §6.62)
 * and its count the header's, else the first tab's (D10). The search, the head's tabs (segmented
 * for two or three) and the `scope` chips leave the head for one quick-return bar
 * (`data-part="list-compact-bar"`), a direct child of the scroller, sticky under the floating row
 * and slid away while the frame reports `barHidden`. The two placements go through `ClassForms`
 * (one search field after hydration); before hydration the compact stylesheet hides the head's
 * tab row. The field `filters` join the rail in the Body's Filter bottom sheet. Medium and
 * expanded keep the search and tabs in the head's tab row, the scope as a Segmented and the
 * filters inline above the list. A list that mounts on a back traversal gets its scroll position
 * back (see `useScrollRestore`, list-scroll.ts).
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
  filterCount,
  scope,
  more,
  children,
}: {
  header: PageHeaderProps;
  rail?: ReactNode;
  actionRow?: ActionRowProps;
  variant?: "objects" | "records" | "cards";
  /** The accessible name of the object list (default: the page title). */
  listLabel?: string;
  callout?: CalloutProps;
  empty?: EmptyStateProps;
  /** The list's first answer is still loading (see {@link ListLoading}). */
  loading?: ListLoading;
  /**
   * Field filters (`Field`, `Select`; spec §2.2 level 3): a row above the list from 600, in the
   * Filter bottom sheet below. Never a view choice: that is `scope`. Kept while loading.
   */
  filters?: ReactNode;
  /** How many `filters` are active: shown on the compact Filter button. */
  filterCount?: number;
  /** The view choice (level 2): chips on compact, a Segmented above the list from 600. Kept while loading. */
  scope?: ListScope;
  /**
   * Reads the next page (`objects` and `cards`): passed to the list, which reads it as its end
   * comes into view below 600 and shows Load more from 600 (see `ListMoreProps`).
   */
  more?: ListMoreProps;
  children?: ReactNode;
}) {
  assertScope(scope, filters);
  const t = useDesignT();
  const form = useClassForm();
  const [bar, setBar] = useState<HTMLElement | null>(null);
  const loading = loadingProp !== false;
  const spec = typeof loadingProp === "object" ? loadingProp : {};
  const rootRef = useScrollRestore(!loading);
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
  // Below 600 the head's primary is restyled as the floating action button (responsive system
  // spec §2.5, §5.4): CSS only, keyed on `data-fab`, so nothing differs between renders.
  const fab = (onePrimary.actions ?? []).some((a) => "variant" in a && a.variant === "primary");
  // The Duo (interaction model §10.3, D10, D14): the head's primary is also the strip pill's, which
  // the shell sends on compact only. It is registered whatever the class (server and first paint
  // agree); with `nav@1` the compact stylesheet hides the FAB form. An empty state carrying the
  // primary leaves it out above, so the pill keeps the new conversation (one primary per screen).
  const primaryAction = (onePrimary.actions ?? []).find(
    (a): a is Extract<HeaderAction, { variant: string }> =>
      "variant" in a && a.variant === "primary",
  );
  useRegisterShellPage({
    ...(primaryAction && !primaryAction.disabled && !primaryAction.loading
      ? {
          primary: {
            id: "list-primary",
            label: primaryAction.label,
            icon: primaryAction.icon === "square-pen" ? "square-pen" : "plus",
            // a link is followed by the shell's own navigation (the app's router)
            ...(primaryAction.href !== undefined
              ? { href: primaryAction.href }
              : { run: () => primaryAction.onSelect?.() }),
          },
        }
      : {}),
  });
  const head = callout ? { ...onePrimary, notice: <Callout {...callout} /> } : onePrimary;

  // One Select for a scope of more than SEGMENTED_MAX options, wide and compact alike (its filter
  // input from ten options); a scope whose options carry avatars stays chips (§6.63).
  const scopeAvatars = scope?.options.some((o) => o.avatar !== undefined) === true;
  const scopeSelect = scope ? (
    <Select
      aria-label={scope.label}
      value={scope.value}
      onChange={(e) => scope.onChange(e.target.value)}
      options={scope.options.map((o) => ({
        value: o.value,
        label: o.count !== undefined ? `${o.label} ${o.count}` : o.label,
      }))}
    />
  ) : null;

  // The compact bar: the search, the head's tabs and the scope chips (spec §2.6).
  const tabItems = head.tabs ?? [];
  const tabSlots = tabItems.length === 0 ? (head.loading?.tabs ?? 0) : 0;
  const hasBar =
    tabItems.length > 0 || head.search !== undefined || scope !== undefined || tabSlots > 0;
  const search = head.search;
  const compactBar = hasBar ? (
    <div ref={setBar} className="cb-list-compact-bar" data-part="list-compact-bar">
      {search ? (
        <div className="cb-list-compact-search" data-part="list-compact-search">
          <HeadSearch search={search} />
        </div>
      ) : null}
      {tabItems.length > 0 ? (
        <Tabs
          look="segmented-compact"
          label={t("shell.pageViews")}
          items={tabItems.map(({ onSelect: _o, ...it }) => it)}
          value={head.activeTab ?? tabItems[0]?.id ?? ""}
          onChange={(id) => tabItems.find((x) => x.id === id)?.onSelect?.()}
        />
      ) : tabSlots > 0 ? (
        <div className="cb-list-compact-tab-slots" data-part="list-compact-tab-slots">
          {Array.from({ length: tabSlots }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the placeholders are positional
            <SkeletonText key={i} width={56} />
          ))}
        </div>
      ) : null}
      {scope ? (
        !scopeAvatars && scope.options.length > SEGMENTED_MAX ? (
          scopeSelect
        ) : (
          <ScopeChips
            label={scope.label}
            value={scope.value}
            options={scope.options}
            onChange={scope.onChange}
          />
        )
      ) : null}
    </div>
  ) : null;
  // On compact after hydration the head gives its tab row up to the bar and keeps the first
  // tab's count beside the title (D10); before hydration it keeps the row, which CSS hides.
  const firstTab = tabItems[0];
  const tabCount = firstTab && !firstTab.pending ? firstTab.count : undefined;
  const compactHead = (): PageHeaderProps => {
    const { tabs: _t, search: _s, activeTab: _a, loading: headLoading, ...rest } = head;
    const count = head.count ?? tabCount;
    const keep = headLoading ? (({ tabs: _x, ...l }) => l)(headLoading) : undefined;
    return {
      ...rest,
      ...(count !== undefined ? { count } : {}),
      ...(keep ? { loading: keep } : {}),
    };
  };
  const shownHead = form === "compact" && hasBar ? compactHead() : head;

  // Wide (spec §2.2 level 2): a Segmented for five options or fewer, one Select for more
  // (its filter input from ten options); a scope whose chips carry avatars (the conversations'
  // agents) stays chips, since neither draws an avatar (§6.63).
  const wideScope = !scope ? null : scopeAvatars ? (
    <ScopeChips
      label={scope.label}
      value={scope.value}
      options={scope.options}
      onChange={scope.onChange}
    />
  ) : scope.options.length <= SEGMENTED_MAX ? (
    <Segmented
      label={scope.label}
      value={scope.value}
      onChange={scope.onChange}
      options={scope.options.map((o) => ({
        value: o.value,
        label: o.count !== undefined ? `${o.label} ${o.count}` : o.label,
      }))}
    />
  ) : (
    scopeSelect
  );

  const loadingList =
    variant === "objects" ? (
      <ObjectList label={listLabel ?? header.title} loading={spec.rows ?? true} />
    ) : variant === "cards" ? (
      <CardGrid label={listLabel ?? header.title} loading={spec.rows ?? true} />
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
    <ObjectList label={listLabel ?? header.title} {...more}>
      {children}
    </ObjectList>
  ) : variant === "cards" ? (
    <CardGrid label={listLabel ?? header.title} {...more}>
      {children}
    </CardGrid>
  ) : (
    children
  );
  const slots = loading && (header.metrics ?? []).length === 0 ? (spec.stats ?? 0) : 0;
  const hasFilters = filters != null && filters !== false;
  const page = (
    <>
      <TemplateHead header={loading ? loadingHeader(shownHead) : shownHead} primaryForm="fab" />
      {hasBar ? <ClassForms compact={compactBar} wide={null} /> : null}
      <Body
        layout={rail != null ? "rail" : "single"}
        rail={rail}
        width="content"
        {...(hasFilters ? { filters } : {})}
        {...(hasFilters && filterCount !== undefined ? { filterCount } : {})}
      >
        <WithStats header={header}>
          <LoadingStats count={slots} />
          {wideScope ? (
            <ClassForms
              compact={null}
              wide={
                <div className="cb-list-filters cb-list-scope" data-part="list-scope">
                  {wideScope}
                </div>
              }
            />
          ) : null}
          {hasFilters ? (
            <ClassForms compact={null} wide={<div className="cb-list-filters">{filters}</div>} />
          ) : null}
          {content}
        </WithStats>
      </Body>
      {actionRow ? <ActionRow {...(loading ? loadingActionRow(actionRow) : actionRow)} /> : null}
    </>
  );
  return (
    <TemplateFrame
      template="ListPage"
      bar={bar}
      rootRef={rootRef}
      data-fab={fab ? "true" : undefined}
      data-compact-bar={hasBar ? "true" : undefined}
    >
      <SkeletonGroup label={header.title || t("table.loading")} active={loading}>
        {page}
      </SkeletonGroup>
    </TemplateFrame>
  );
}
