import { Icon } from "../icons/icon";
import type { IconName } from "../icons/paths";
import { LinkPendingMark, useDesignLink, useDesignT } from "../provider";

/** One of the four compact navigation items (design spec §6.45). */
export type BottomNavItem = {
  id: "chats" | "agents" | "inbox" | "me";
  label: string;
  href: string;
  icon: IconName;
  /** The pending count (the inbox), drawn as the nav badge while above 0 (`99+` above 99). */
  count?: number;
  /** The count is truncated: `n+`. */
  countMore?: boolean;
  /**
   * Other route prefixes the tab holds besides its own `href` (its pushed pages): the tab stays
   * current on them, though they are not tab roots (spec §4.6).
   */
  also?: string[];
};

export type BottomNavProps = {
  items: BottomNavItem[];
  /** The current item's id: its icon and label are `ink`, the label weight 500. */
  current?: BottomNavItem["id"] | null | undefined;
  /** Draw the short form (labels hidden) whatever the window height: the reference set only. */
  short?: boolean;
};

const underPath = (pathname: string, prefix: string) =>
  prefix === "/" ? pathname === "/" : pathname === prefix || pathname.startsWith(`${prefix}/`);

/** Whether `pathname` is exactly a tab root (the target of an item): no back, the bar shows. */
export function isTabRoot(items: readonly BottomNavItem[], pathname: string): boolean {
  return items.some((i) => i.href === pathname);
}

/**
 * The item whose root or pushed pages hold `pathname` (the longest matching prefix among every
 * item's `href` and `also`), or null when none does.
 */
export function bottomNavCurrent(
  items: readonly BottomNavItem[],
  pathname: string,
): BottomNavItem["id"] | null {
  let best: { id: BottomNavItem["id"]; len: number } | null = null;
  for (const item of items) {
    for (const prefix of [item.href, ...(item.also ?? [])]) {
      if (underPath(pathname, prefix) && (best === null || prefix.length > best.len))
        best = { id: item.id, len: prefix.length };
    }
  }
  return best?.id ?? null;
}

const countText = (n: { count?: number; countMore?: boolean }): string =>
  (n.count ?? 0) > 99 ? "99+" : `${n.count ?? 0}${n.countMore ? "+" : ""}`;

/**
 * The compact class's navigation (design spec §6.45): four links, a `nav` named 主导航, on tab
 * roots only. `AppShell` draws it from the same `useNav` data the sidebar takes; the shell's slot
 * decides where it shows (compact, tab roots, no open keyboard), the bar itself is always drawn.
 */
export function BottomNav({ items, current, short }: BottomNavProps) {
  const t = useDesignT();
  const Link = useDesignLink();
  return (
    <nav
      className="cb-bottomnav"
      data-part="bottom-nav"
      aria-label={t("shell.nav")}
      data-short={short ? "true" : undefined}
    >
      {items.map((item) => {
        const count = (item.count ?? 0) > 0 ? countText(item) : null;
        const name =
          count === null
            ? item.label
            : t("shell.navCount").replace("{label}", item.label).replace("{n}", count);
        return (
          <Link
            key={item.id}
            href={item.href}
            className="cb-bottomnav-item"
            data-part="item"
            data-id={item.id}
            aria-label={name}
            {...(item.id === current ? { "aria-current": "page" as const } : {})}
          >
            <span className="cb-bottomnav-icon">
              <Icon name={item.icon} size={16} />
              {count === null ? null : (
                <span className="cb-bottomnav-badge" data-part="item-badge" aria-hidden="true">
                  {count}
                </span>
              )}
            </span>
            <span className="cb-bottomnav-label" data-part="item-label">
              {item.label}
            </span>
            <LinkPendingMark />
          </Link>
        );
      })}
    </nav>
  );
}
