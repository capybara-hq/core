import { Fragment, type ReactNode, useMemo, useRef } from "react";
import { Button, IconButton, Input, LinkButton } from "../controls/index";
import type { MetricProps } from "../display/index";
import {
  SkeletonAnnouncement,
  SkeletonBox,
  SkeletonText,
  useSkeletonAnnounces,
} from "../display/skeleton";
import { Tabs } from "../display/tabs";
import { Icon } from "../icons/icon";
import type { IconName } from "../icons/paths";
import { Menu, type MenuItem, menuActions, menuLone } from "../overlays/index";
import { LinkPendingMark, useDesignLink, useDesignT } from "../provider";
import { ClassForms, useClassForm } from "./class-forms";
import { DragFill } from "./drag-fill";
import { useHasShell, useRegisterShellPage } from "./shell-page";

type HeaderButton = {
  label: string;
  /** A leading icon (such as `plus` on a create action). */
  icon?: IconName;
  variant: "primary" | "secondary" | "default";
  shortcut?: string;
  /** Its call is running: the Button's loading state (spinner, `aria-busy`, disabled). */
  loading?: boolean;
  /** Another action's call is running (spec §6.17: never a click that seems to do nothing). */
  disabled?: boolean;
};

/** A button (onSelect) or a link (href), never both; a `more-horizontal` menu is its own kind. */
export type HeaderAction =
  | (HeaderButton & { onSelect?(): void; href?: undefined })
  | (HeaderButton & { href: string; onSelect?: undefined })
  | { menu: MenuItem[]; label: string };

export type PageHeaderProps = {
  /**
   * Row 1: the path line `scope / page / object` (spec §4.2), mono; a segment with `href` is a
   * link, the last one is the current page (`aria-current="page"`).
   */
  path: { label: string; href?: string }[];
  /** Row 2: an h1, one line with an ellipsis, the full text in `title`. */
  title: string;
  /**
   * A page whose first block is its own name band (the device page's `DeviceNameplate`) leaves
   * the title row out (spec §4.2 "A title-less head"): the path and the actions share one row and
   * `title` stays as a visually hidden h1 for assistive tech. The description, count, status and
   * avatar have no row of their own in this variant.
   */
  titleHidden?: boolean;
  /** Row 2, before the title and description: the object's avatar (an `Avatar` at 40). */
  avatar?: ReactNode;
  /** One line under the title (`prose-small`, `muted`), with an ellipsis. */
  description?: string;
  count?: React.ReactNode;
  status?: React.ReactNode;
  /** Key metrics, at most 5: the template draws them below the header as StatCards. */
  metrics?: MetricProps[];
  /** Row 2 right; at most one primary, rightmost. */
  actions?: HeaderAction[];
  /** Between the title row and the tabs: a Callout naming what needs action (ListPage `callout`). */
  notice?: ReactNode;
  /** Row 4 (optional): the page's views with counts; the search sits at the row's right end. */
  tabs?: {
    id: string;
    label: string;
    count?: number;
    /** The count is not known yet (ListPage `loading` sets it): a muted dash. */
    pending?: boolean;
    href?: string;
    onSelect?(): void;
  }[];
  /** The selected tab's id. */
  activeTab?: string;
  /** The search field at the right end of the tabs row. */
  search?: { label: string; value: string; onChange(v: string): void };
  /**
   * The page's data is on its way (spec §4.2, §6.29). `title`: the title is not known yet, a
   * `title`-size bar of 30% stands in for the h1. `actions` / `tabs`: how many placeholders to
   * draw when the page does not know its actions or tabs yet; the ones given in `actions` /
   * `tabs` always render for real, and then no placeholder is drawn.
   */
  /**
   * The header's loading state (spec §4.2): `title` draws a title bar, `avatar` a 40 px block where
   * the object's avatar will be (so the row keeps the loaded height), `actions` / `tabs` slot counts.
   */
  loading?: { title?: boolean; avatar?: boolean; actions?: number; tabs?: number };
  /**
   * Where the primary goes on compact (responsive system spec §2.1, D2; set by the template, never
   * by a page): `"head"` (default) the head's own button; `"fab"` the same button, which the
   * ListPage's `data-fab` CSS restyles as its floating action button (design spec §6.62);
   * `"block"` a full-width button under the title (DetailPage, SettingsPage, OverviewPage).
   * Medium and expanded draw the head button whatever it says (D9).
   */
  primaryForm?: "head" | "fab" | "block";
};

/** Spec §4.2: metrics ≤ 5, at most one solid primary. Throws in development and tests. */
export function assertHeader(p: PageHeaderProps): void {
  const problems: string[] = [];
  if ((p.metrics?.length ?? 0) > 5) problems.push("PageHeader: metrics must be <= 5");
  const primaries = (p.actions ?? []).filter((a) => "variant" in a && a.variant === "primary");
  if (primaries.length > 1) problems.push("PageHeader: at most one primary action");
  if (problems.length === 0) return;
  const msg = problems.join("; ");
  if (process.env.NODE_ENV === "production") console.error(msg);
  else throw new Error(msg);
}

const shown = (v: React.ReactNode) => v != null && v !== false;

/**
 * Whether the header draws its tab row (row 4, spec §4.2): tabs, the search, or tab placeholders
 * while loading. The one place this is decided: the PageHeader draws the row by it, and the
 * template head picks its head-to-content gap by it (spec §4.2 "Head rhythm").
 */
export function hasTabRow(p: PageHeaderProps): boolean {
  return (p.tabs?.length ?? 0) > 0 || p.search !== undefined || (p.loading?.tabs ?? 0) > 0;
}

/** What menu items show: every field but the handlers, submenus included. */
function shownKey(items: readonly MenuItem[]): unknown[] {
  return items.map((it) =>
    it === "separator"
      ? it
      : Object.keys(it)
          .sort()
          .flatMap((k) => {
            const v = (it as Record<string, unknown>)[k];
            if (typeof v === "function") return [];
            return [[k, k === "submenu" ? shownKey(v as MenuItem[]) : v]];
          }),
  );
}

/** The item at `path` (indices through submenus) in `items`. */
function itemAt(items: readonly MenuItem[], path: readonly number[]): MenuItem | undefined {
  let level: readonly MenuItem[] | undefined = items;
  let found: MenuItem | undefined;
  for (const i of path) {
    found = level?.[i];
    level = found === undefined || found === "separator" ? undefined : found.submenu;
  }
  return found;
}

/**
 * The secondary actions as menu items whose handlers (in submenus too) always call the page's
 * latest ones, with an identity that changes only when what the menu shows changes (any field but
 * a handler), so registering them with the shell does not re-register on every render.
 */
function useStableItems(items: MenuItem[]): MenuItem[] {
  const latest = useRef(items);
  latest.current = items;
  const key = JSON.stringify(shownKey(items));
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for what the items show
  return useMemo(() => {
    const wrap = (level: readonly MenuItem[], path: readonly number[]): MenuItem[] =>
      level.map((it, i): MenuItem => {
        if (it === "separator") return it;
        const here = [...path, i];
        if (it.submenu !== undefined) return { ...it, submenu: wrap(it.submenu, here) };
        if (it.onSelect === undefined) return it;
        const { onSelect: _drop, ...rest } = it;
        return {
          ...rest,
          onSelect: () => {
            const now = itemAt(latest.current, here);
            if (now !== undefined && now !== "separator") now.onSelect?.();
          },
        } as MenuItem;
      });
    return wrap(latest.current, []);
  }, [key]);
}

/**
 * The head's search field (spec §4.2 row 4): its label is its accessible name and placeholder.
 * The one field the PageHeader's tab row and a compact ListPage's quick-return bar both draw.
 */
export function HeadSearch({ search }: { search: NonNullable<PageHeaderProps["search"]> }) {
  return (
    <Input
      type="search"
      aria-label={search.label}
      placeholder={search.label}
      value={search.value}
      onChange={(e) => search.onChange(e.target.value)}
      prefix={<Icon name="search" size={14} />}
    />
  );
}

/** The number of path segments of a route (`/admin/plugins/market` is 3; a query does not count). */
const routeDepth = (href: string) =>
  (href.split(/[?#]/)[0] ?? "").split("/").filter((s) => s !== "").length;

/**
 * The path a head stands at (spec §4.2 path rule, maintainer decision 2026-11-28): a head whose
 * tabs are routes (each tab its own page, `href`) is one place, so every tab's route has the level
 * of the head's first tab. On a tab whose route is deeper than the first tab's, the segments it adds
 * (the tab's own) go: `Admin console / Connectors / Templates` stands at `Admin console /
 * Connectors`, which, two segments, draws no path row, as on the first tab. The compact back walks
 * this path too.
 */
export function headPath(
  path: PageHeaderProps["path"],
  tabs: PageHeaderProps["tabs"],
  activeTab: string | undefined,
): PageHeaderProps["path"] {
  const first = tabs?.[0]?.href;
  const open = tabs?.find((t) => t.id === (activeTab ?? tabs[0]?.id))?.href;
  if (first === undefined || open === undefined) return path;
  const extra = routeDepth(open) - routeDepth(first);
  return extra > 0 && path.length > extra ? path.slice(0, path.length - extra) : path;
}

/**
 * The page header (spec §4.2): row 1 the path, row 2 the title (+ count / status) and the
 * description, actions on the right. No line, no ground. Compact (below 600; responsive system
 * spec §2.1, design spec §4.2 "Compact head") draws no path row, puts the count beside the large
 * title (`count`, else the first tab's count), sends every secondary action to the shell's "…"
 * (`ShellPage.actions`; without a shell a `more-horizontal` menu in the head), places the primary
 * by `primaryForm` and draws 2-3 tabs as a segmented control; the per-class structure goes through
 * `ClassForms`, and the primary stays one element in both forms. The vertical rhythm is the head
 * tokens (spec §4.2 "Head rhythm"): `layout.head-path` between the path and the title row,
 * `layout.head-description` between the title and the description, `layout.head-tabs` above the
 * notice and the tab row.
 */
export function PageHeader(p: PageHeaderProps) {
  assertHeader(p);
  // The compact floating row goes up the page's path (design spec §4.6, §6.56).
  const t = useDesignT();
  const Link = useDesignLink();
  const hasShell = useHasShell();
  const form = useClassForm();
  const announces = useSkeletonAnnounces();
  // A tab's route stands at its head's first tab's level (headPath).
  const segments = headPath(p.path, p.tabs, p.activeTab);
  const tabItems = p.tabs ?? [];
  // The primary action is rightmost (spec §4.2), whatever order the page gives.
  const isPrimary = (a: HeaderAction) => "variant" in a && a.variant === "primary";
  // No menu of one (spec §6.7): a menu action with one safe item is that item, with none it is
  // dropped; a lone destructive item stays in its menu.
  const given = (p.actions ?? []).flatMap((a): HeaderAction[] => {
    if (!("menu" in a)) return [a];
    if (menuActions(a.menu).length === 0) return [];
    const only = menuLone(a.menu);
    if (only === undefined) return [a];
    return [
      only.href !== undefined
        ? { label: only.label, variant: "default", href: only.href }
        : { label: only.label, variant: "default", onSelect: () => only.onSelect?.() },
    ];
  });
  const actions = [...given.filter((a) => !isPrimary(a)), ...given.filter(isPrimary)];
  const folded: MenuItem[] = [];
  for (const a of actions) {
    if (isPrimary(a)) continue;
    if ("menu" in a) folded.push(...a.menu);
    else if (a.href !== undefined) folded.push({ label: a.label, href: a.href });
    else {
      folded.push({
        label: a.label,
        onSelect: () => a.onSelect?.(),
        ...(a.loading || a.disabled ? { disabled: true } : {}),
      });
    }
  }
  // The shell's floating row draws them in its "…" (shown on compact only, by CSS), so they are
  // registered whatever the class: the server render and the first paint agree (D1).
  const shellActions = useStableItems(folded);
  useRegisterShellPage({
    ...(p.title ? { title: p.title } : {}),
    path: segments,
    ...(hasShell && folded.length > 0 ? { actions: shellActions } : {}),
  });
  const rest = actions.filter((a) => !isPrimary(a));
  const primaries = actions.filter(isPrimary);
  const primaryForm = p.primaryForm ?? "head";
  const content = (a: Extract<HeaderAction, { variant: string }>, primary: boolean) =>
    primary ? (
      <>
        <span className="cb-pageheader-primary-icon" data-implicit={a.icon ? undefined : "true"}>
          <Icon name={a.icon ?? "plus"} size={14} />
        </span>
        <span className="cb-pageheader-primary-label">{a.label}</span>
      </>
    ) : (
      <>
        {a.icon ? <Icon name={a.icon} size={14} /> : null}
        {a.label}
      </>
    );
  const renderAction = (a: HeaderAction, primary = false) => {
    if ("menu" in a) {
      return (
        <Menu
          key={a.label}
          items={a.menu}
          trigger={
            <IconButton
              label={a.label}
              icon={<Icon name="more-horizontal" />}
              density="default"
              variant="default"
            />
          }
        />
      );
    }
    if (a.href !== undefined) {
      return (
        <LinkButton
          key={a.label}
          href={a.href}
          variant={a.variant}
          density="default"
          {...(a.shortcut !== undefined ? { shortcut: a.shortcut } : {})}
        >
          {content(a, primary)}
        </LinkButton>
      );
    }
    return (
      <Button
        key={a.label}
        variant={a.variant}
        density="default"
        {...(a.shortcut !== undefined ? { shortcut: a.shortcut } : {})}
        {...(a.loading ? { loading: true } : {})}
        {...(a.disabled ? { disabled: true } : {})}
        {...(a.onSelect ? { onClick: a.onSelect } : {})}
      >
        {content(a, primary)}
      </Button>
    );
  };
  // The primary in a wrapper of no box of its own. A ListPage restyles this very button as its
  // floating action button below 600 (responsive system spec §2.5, §5.4: one DOM, CSS only), so
  // its icon (default `plus`, drawn only there when the action has none) and label are parts.
  // `data-form` names its compact form: `block` CSS makes it the full-width button under the
  // title (the actions take a line of their own there), `fab` the ListPage's CSS restyles it.
  const renderPrimary = (a: HeaderAction) => (
    <span
      key={`primary-${a.label}`}
      className="cb-pageheader-primary"
      data-head-primary="true"
      data-form={primaryForm}
    >
      {renderAction(a, true)}
    </span>
  );
  // The secondaries per class (spec §5.4, D1, D9): wide draws them as buttons; compact folds them
  // all into the head's ⋯ (also one), which a hydrated page in a shell drops because the shell's
  // "…" holds them then. The server render and the first client render (`form` null) keep the
  // head ⋯, so a page without JavaScript still reaches them (coordinator ruling 2026-11-22).
  const secondaries: ReactNode =
    rest.length === 0 ? null : (
      <ClassForms
        key="secondaries"
        compact={
          hasShell && form !== null
            ? null
            : renderAction({ label: t("shell.moreActions"), menu: folded })
        }
        wide={rest.map((a) => renderAction(a))}
      />
    );
  const drawn: ReactNode[] = [secondaries, ...primaries.map(renderPrimary)];
  const loading = p.loading;
  const actionSlots = actions.length === 0 ? (loading?.actions ?? 0) : 0;
  const tabSlots = tabItems.length === 0 ? (loading?.tabs ?? 0) : 0;
  // On compact the placeholders are what the loaded actions line will show (design spec §4.2), so
  // the head keeps its height: in a shell the secondaries go to its "…" and one slot stands for
  // the primary (none for a FAB, which is out of flow); outside a shell the ⋯ and the primary.
  const compactSlots =
    primaryForm === "fab"
      ? hasShell || actionSlots < 2
        ? 0
        : 1
      : hasShell
        ? Math.min(actionSlots, 1)
        : Math.min(actionSlots, 2);
  const slotBoxes = (n: number) =>
    n === 0
      ? null
      : Array.from({ length: n }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the placeholders are positional
          <SkeletonBox key={i} part="default" width={72} />
        ));
  const navNode =
    segments.length > 0 ? (
      <nav className="cb-pageheader-path" data-part="path" aria-label={t("shell.path")}>
        {segments.map((c, i) => {
          const last = i === segments.length - 1;
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional (labels may repeat)
            <Fragment key={`${i}-${c.label}`}>
              {i > 0 ? (
                <span className="cb-pageheader-path-sep" aria-hidden="true">
                  /
                </span>
              ) : null}
              {c.href !== undefined && !last ? (
                <Link href={c.href} className="cb-pageheader-path-seg">
                  {c.label}
                  <LinkPendingMark />
                </Link>
              ) : (
                <span
                  className="cb-pageheader-path-seg"
                  data-current={last ? "true" : undefined}
                  aria-current={last ? "page" : undefined}
                >
                  {c.label}
                </span>
              )}
            </Fragment>
          );
        })}
        <DragFill />
      </nav>
    ) : null;
  // No path row on compact (design spec §4.2): the floating row's back and the h1 name the page.
  // Before hydration the path is drawn and the compact stylesheet hides it; after, compact drops
  // it (one element, no ClassForms wrapper: the path keeps its place as the head's first row).
  // A first-level page (scope / page: two segments or fewer) draws none at any width: the
  // sidebar already names the place. The path stays a prop (the compact back walks it). An
  // object page passes its two-segment parent path while its name loads (`loading.title`): it
  // counts as deep already, so the path row does not appear under a loaded head and shift it.
  const firstLevel = segments.length <= 1 || (segments.length === 2 && loading?.title !== true);
  const pathNode = form === "compact" || firstLevel ? null : navNode;
  const actionsNode =
    actions.length > 0 ? (
      <div className="cb-pageheader-actions" data-part="page-header-actions">
        {drawn}
      </div>
    ) : actionSlots > 0 ? (
      <div
        className="cb-pageheader-actions"
        data-part="page-header-action-slots"
        data-form={primaryForm}
      >
        <ClassForms compact={slotBoxes(compactSlots)} wide={slotBoxes(actionSlots)} />
      </div>
    ) : null;
  // The count beside the title: `count`; on compact, without one, the first tab's (D10).
  const tabCount = tabItems[0]?.pending ? undefined : tabItems[0]?.count;
  const countSpan = (v: ReactNode) => <span className="cb-pageheader-count">{v}</span>;
  const countNode = shown(p.count) ? (
    countSpan(p.count)
  ) : tabCount !== undefined ? (
    <ClassForms compact={countSpan(tabCount)} wide={null} />
  ) : null;
  return (
    <header
      className="cb-pageheader"
      data-part="page-header"
      data-cap-part="page-header"
      aria-busy={loading && announces ? "true" : undefined}
    >
      {loading && announces ? <SkeletonAnnouncement /> : null}
      {p.titleHidden === true ? (
        // The page draws its own name band as the first block (spec §4.2 "A title-less head"):
        // the path and the actions share one row and the name stays an h1 for assistive tech.
        <div className="cb-pageheader-titleless" data-part="page-header-titleless">
          <h1 className="cb-sr-only">{p.title}</h1>
          {/* Without a path row the filler stands before the actions (the head's drag area). */}
          {pathNode ?? (form === "compact" ? null : <DragFill />)}
          {actionsNode}
        </div>
      ) : (
        <>
          {pathNode}
          <div
            className="cb-pageheader-row"
            data-part="page-header-row"
            data-avatar={shown(p.avatar) || loading?.avatar ? "true" : undefined}
          >
            {shown(p.avatar) ? (
              <span className="cb-pageheader-avatar" data-part="page-header-avatar">
                {p.avatar}
              </span>
            ) : loading?.avatar ? (
              <span className="cb-pageheader-avatar" data-part="page-header-avatar">
                <SkeletonBox part="block" width={40} height={40} />
              </span>
            ) : null}
            <div className="cb-pageheader-text">
              <div className="cb-pageheader-titleline">
                {loading?.title ? (
                  <span className="cb-pageheader-title-bar" data-part="page-header-title-bar">
                    <SkeletonText width="30%" size="title" />
                  </span>
                ) : (
                  <h1 className="cb-pageheader-title" data-part="page-header-title" title={p.title}>
                    {p.title}
                  </h1>
                )}
                {countNode}
                {shown(p.status) ? <span className="cb-pageheader-count">{p.status}</span> : null}
              </div>
              {p.description ? (
                <p
                  className="cb-pageheader-description"
                  data-part="page-header-description"
                  title={p.description}
                >
                  {p.description}
                </p>
              ) : null}
            </div>
            {/* The title row's drag area in a desktop shell (spec §5): the room before the
                actions, so a page without a path row still drags the window. */}
            <DragFill />
            {actionsNode}
          </div>
        </>
      )}
      {shown(p.notice) ? <div className="cb-pageheader-notice">{p.notice}</div> : null}
      {hasTabRow(p) ? (
        <div className="cb-pageheader-tabs" data-part="page-header-tabs">
          {tabItems.length > 0 ? (
            <Tabs
              look="segmented-compact"
              label={t("shell.pageViews")}
              items={tabItems.map(({ onSelect: _o, ...it }) => it)}
              value={p.activeTab ?? tabItems[0]?.id ?? ""}
              onChange={(id) => tabItems.find((x) => x.id === id)?.onSelect?.()}
            />
          ) : tabSlots > 0 ? (
            <div className="cb-pageheader-tab-slots" data-part="page-header-tab-slots">
              {Array.from({ length: tabSlots }, (_, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: the placeholders are positional
                <SkeletonText key={i} width={56} />
              ))}
            </div>
          ) : null}
          {p.search ? (
            <div className="cb-pageheader-search" data-part="page-header-search">
              <HeadSearch search={p.search} />
            </div>
          ) : null}
        </div>
      ) : null}
    </header>
  );
}
