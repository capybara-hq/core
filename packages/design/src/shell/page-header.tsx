import { Fragment, type ReactNode } from "react";
import { Button, IconButton } from "../controls/index";
import type { MetricProps } from "../display/index";
import { Icon } from "../icons/icon";
import type { IconName } from "../icons/paths";
import { Menu, type MenuItem } from "../overlays/index";
import { useDesignLink, useDesignT } from "../provider";
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
  /** Row 1 (optional): links to the parents, in order; a crumb without `href` is plain text. */
  breadcrumb?: { label: string; href?: string }[];
  /** Row 2: an h1, one line with an ellipsis, the full text in `title`. */
  title: string;
  /** One line under the title (`prose-small`, `muted`), with an ellipsis. */
  description?: string;
  count?: React.ReactNode;
  status?: React.ReactNode;
  /** Key metrics, at most 5: the template draws them below the header as StatCards. */
  metrics?: MetricProps[];
  /** Row 2 right; at most one primary, rightmost. */
  actions?: HeaderAction[];
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
 * The page header (spec §4.2): row 1 the breadcrumb, row 2 the title (+ count / status) and the
 * description, actions on the right. No line, no ground. Below 640 the actions other than the
 * primary fold into a `more-horizontal` menu.
 */
export function PageHeader(p: PageHeaderProps) {
  assertHeader(p);
  const t = useDesignT();
  const Link = useDesignLink();
  const narrow = useMediaQuery("(max-width: 639px)");
  const crumbs = p.breadcrumb ?? [];
  // The primary action is rightmost (spec §4.2), whatever order the page gives.
  const isPrimary = (a: HeaderAction) => "variant" in a && a.variant === "primary";
  const actions = [
    ...(p.actions ?? []).filter((a) => !isPrimary(a)),
    ...(p.actions ?? []).filter(isPrimary),
  ];
  const folded: MenuItem[] = [];
  for (const a of actions) {
    if (isPrimary(a)) continue;
    if ("menu" in a) folded.push(...a.menu);
    else if (a.href !== undefined) folded.push({ label: a.label, href: a.href });
    else folded.push({ label: a.label, onSelect: () => a.onSelect?.() });
  }
  const more: HeaderAction | null =
    folded.length > 0 ? { label: t("shell.moreActions"), menu: folded } : null;
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
        <Link key={a.label} href={a.href} className={`cb-btn cb-btn-link cb-btn-link-${a.variant}`}>
          {/* The same content structure as Button, so the shortcut hint matches */}
          <span className="cb-btn-body">
            {a.icon ? <Icon name={a.icon} size={14} /> : null}
            {a.label}
            {a.shortcut ? <span className="cb-btn-shortcut">{a.shortcut}</span> : null}
          </span>
        </Link>
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
  const drawn: ReactNode[] = pre
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
  return (
    <header className="cb-pageheader" data-part="page-header">
      {crumbs.length > 0 ? (
        <nav
          className="cb-pageheader-crumbs"
          data-part="breadcrumb"
          aria-label={t("shell.breadcrumb")}
        >
          {crumbs.map((c, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: crumbs are positional (labels may repeat)
            <Fragment key={`${i}-${c.label}`}>
              {i > 0 ? (
                <span className="cb-pageheader-crumb-sep" aria-hidden="true">
                  /
                </span>
              ) : null}
              {c.href !== undefined ? (
                <Link href={c.href} className="cb-pageheader-crumb">
                  {c.label}
                </Link>
              ) : (
                <span className="cb-pageheader-crumb">{c.label}</span>
              )}
            </Fragment>
          ))}
        </nav>
      ) : null}
      <div className="cb-pageheader-row">
        <div className="cb-pageheader-text">
          <div className="cb-pageheader-titleline">
            <h1 className="cb-pageheader-title" data-part="page-header-title" title={p.title}>
              {p.title}
            </h1>
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
          <div className="cb-pageheader-actions" data-responsive={pre ? "true" : undefined}>
            {drawn}
          </div>
        ) : null}
      </div>
    </header>
  );
}
