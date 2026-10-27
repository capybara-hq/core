import type { SidebarGroup, SidebarNavItem, SidebarProps } from "@capybara-hq/design";
import {
  EXTENSION_PAGES_FIXTURE,
  FIXTURE_ORG,
  FIXTURE_USER,
  type FixtureGroup,
  type FixtureNavItem,
  GROUPS_FIXTURE,
  LONG_TITLE_GROUP_FIXTURE,
  MANY_GROUPS_FIXTURE,
  MANY_GROUPS_MORE,
  NAV_FIXTURE,
  STATUS_FIXTURE,
} from "@capybara-hq/design/fixtures";

// The sidebar and status bar of the catalog: shared by the reference blocks and FixtureShell.

const noop = () => {};

const VISIBLE: Record<"guest" | "enterprise", FixtureNavItem["audience"][]> = {
  guest: ["all"],
  enterprise: ["all", "member", "admin", "enterprise"],
};

/** "2026-10-20T14:32:00+08:00" as that wall-clock time, so untitled labels read the same anywhere. */
function wallClock(iso: string): Date {
  const [y, mo, d, h, mi] = (iso.match(/\d+/g) ?? []).map(Number);
  return new Date(y ?? 0, (mo ?? 1) - 1, d ?? 1, h ?? 0, mi ?? 0);
}

export type SidebarFixture = {
  active?: string;
  activeConversation?: string;
  /** Shows the active conversation under this title (the conversation-page blocks). */
  activeTitle?: string;
  level?: "guest" | "enterprise";
  state?: "loading" | "error" | "empty";
  groups?: "long" | "many";
  collapsed?: string[];
};

/**
 * Sidebar props from the shared fixtures. `href(id)` gives the link of a nav item, extension page
 * or conversation id ("new" for New conversation).
 */
export function sidebarProps(o: SidebarFixture, href: (id: string) => string): SidebarProps {
  const visible = NAV_FIXTURE.filter((n) => VISIBLE[o.level ?? "enterprise"].includes(n.audience));
  const item = (n: FixtureNavItem): SidebarNavItem => ({
    id: n.id,
    label: n.label,
    href: href(n.id),
    icon: n.icon,
    ...(n.count !== undefined ? { count: n.count } : {}),
  });
  const footer = (n: FixtureNavItem) => n.id === "settings" || n.id === "admin";
  const toGroup = (g: FixtureGroup): SidebarGroup => ({
    agentId: g.agentId,
    agentName: g.agentName,
    conversations: g.conversations.map((c) => ({
      id: c.id,
      title: o.activeTitle !== undefined && c.id === o.activeConversation ? o.activeTitle : c.title,
      startedAt: wallClock(c.startedAt),
      href: href(c.id),
    })),
    more: g.more,
    onMore: noop,
    onNew: noop,
  });
  const groups =
    o.groups === "long"
      ? [LONG_TITLE_GROUP_FIXTURE, ...GROUPS_FIXTURE.slice(1)]
      : o.groups === "many"
        ? MANY_GROUPS_FIXTURE
        : GROUPS_FIXTURE;
  return {
    newConversation: { href: href("new") },
    nav: visible.filter((n) => !footer(n)).map(item),
    activeNav: o.active ?? "",
    extensions: EXTENSION_PAGES_FIXTURE.map((x) => ({ ...x, href: href(x.id) })),
    footerNav: visible.filter(footer).map(item),
    conversations: {
      state: o.state === "loading" || o.state === "error" ? o.state : "ready",
      groups: o.state === undefined ? groups.map(toGroup) : [],
      ...(o.activeConversation ? { activeId: o.activeConversation } : {}),
      moreGroups: o.groups === "many" && MANY_GROUPS_MORE,
      onMoreGroups: noop,
      onRetry: noop,
      collapsed: o.collapsed ?? [],
    },
    account: { name: FIXTURE_USER.name, org: FIXTURE_ORG, menu: [] },
    onOpenCommands: noop,
  };
}

/** The status bar of a catalog page at `route` (`/connectors`, …). */
export function statusFixture(route: string) {
  return {
    context: `${FIXTURE_USER.name}@${FIXTURE_ORG}:${route}`,
    version: STATUS_FIXTURE.version,
    timeZone: STATUS_FIXTURE.timeZone,
    system: STATUS_FIXTURE.system,
  };
}
