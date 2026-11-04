import { Fragment, type ReactNode } from "react";
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
import { useHydrated, useMediaQuery } from "./use-media-query";

type HeaderButton = {
  label: string;
  /** A leading icon (such as `plus` on a create action). */
  icon?: IconName;
  variant: "primary" | "secondary" | "default";
  shortcut?: string;
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
 * The page header (spec §4.2): row 1 the path, row 2 the title (+ count / status) and the
 * description, actions on the right. No line, no ground. Below 640 the actions other than the
 * primary fold into a `more-horizontal` menu.
 */
export function PageHeader(p: PageHeaderProps) {
  assertHeader(p);
  const t = useDesignT();
  const Link = useDesignLink();
  const narrow = useMediaQuery("(max-width: 639px)");
  const announces = useSkeletonAnnounces();
  const segments = p.path;
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
    else folded.push({ label: a.label, onSelect: () => a.onSelect?.() });
  }
  // One action besides the primary stays a button below 640 too.
  const more: HeaderAction | null =
    folded.length > 1 ? { label: t("shell.moreActions"), menu: folded } : null;
  const rest = actions.filter((a) => !isPrimary(a));
  const primaries = actions.filter(isPrimary);
  // Before hydration both the inline actions and the fold menu are drawn and CSS media queries
  // show one (m6), so the first paint below 640 never lays every action out in one row.
  const pre = !useHydrated();
  const renderAction = (a: HeaderAction) => {
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
          {a.icon ? <Icon name={a.icon} size={14} /> : null}
          {a.label}
        </LinkButton>
      );
    }
    return (
      <Button
        key={a.label}
        variant={a.variant}
        density="default"
        {...(a.shortcut !== undefined ? { shortcut: a.shortcut } : {})}
        {...(a.onSelect ? { onClick: a.onSelect } : {})}
      >
        {a.icon ? <Icon name={a.icon} size={14} /> : null}
        {a.label}
      </Button>
    );
  };
  const drawn: ReactNode[] = !more
    ? actions.map(renderAction)
    : pre
      ? [
          ...rest.map((a) => (
            <span key={`inline-${a.label}`} className="cb-pageheader-fold" data-fold="inline">
              {renderAction(a)}
            </span>
          )),
          more ? (
            <span key="fold-menu" className="cb-pageheader-fold" data-fold="menu">
              {renderAction(more)}
            </span>
          ) : null,
          ...primaries.map(renderAction),
        ]
      : narrow
        ? [more ? renderAction(more) : null, ...primaries.map(renderAction)]
        : actions.map(renderAction);
  const loading = p.loading;
  const actionSlots = actions.length === 0 ? (loading?.actions ?? 0) : 0;
  const tabSlots = tabItems.length === 0 ? (loading?.tabs ?? 0) : 0;
  return (
    <header
      className="cb-pageheader"
      data-part="page-header"
      aria-busy={loading && announces ? "true" : undefined}
    >
      {loading && announces ? <SkeletonAnnouncement /> : null}
      {segments.length > 0 ? (
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
        </nav>
      ) : null}
      <div className="cb-pageheader-row">
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
            {shown(p.count) ? <span className="cb-pageheader-count">{p.count}</span> : null}
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
        {actions.length > 0 ? (
          <div
            className="cb-pageheader-actions"
            data-part="page-header-actions"
            data-responsive={pre && more ? "true" : undefined}
          >
            {drawn}
          </div>
        ) : actionSlots > 0 ? (
          <div className="cb-pageheader-actions" data-part="page-header-action-slots">
            {Array.from({ length: actionSlots }, (_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the placeholders are positional
              <SkeletonBox key={i} part="default" width={72} />
            ))}
          </div>
        ) : null}
      </div>
      {p.notice ?? null}
      {tabItems.length > 0 || p.search || tabSlots > 0 ? (
        <div className="cb-pageheader-tabs" data-part="page-header-tabs">
          {tabItems.length > 0 ? (
            <Tabs
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
              <Input
                type="search"
                aria-label={p.search.label}
                placeholder={p.search.label}
                value={p.search.value}
                onChange={(e) => p.search?.onChange(e.target.value)}
                prefix={<Icon name="search" size={14} />}
              />
            </div>
          ) : null}
        </div>
      ) : null}
    </header>
  );
}
