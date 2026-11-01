import type { SetupStep, SidebarGroup, SidebarNavItem, SidebarProps } from "@capybara-hq/design";
import {
  ADMIN_NAV_FIXTURE,
  ARCHIVED_COUNT_FIXTURE,
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
  ORG_SWITCHER_FIXTURE,
  SETUP_STEPS_FIXTURE,
  STATUS_FIXTURE,
} from "@capybara-hq/design/fixtures";

// The sidebar and status bar of the catalog: shared by the reference blocks and FixtureShell.

const noop = () => {};
const done = async () => {};

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
  /** The admin console's or the guided setup's context instead of the workspace's. */
  context?: "admin" | "setup";
  /** The setup context's steps: the enterprise admin's (default) or a member's. */
  setup?: "admin" | "member";
  /** Draw the 更多 flyout open. */
  moreOpen?: boolean;
  /** Draw the conversation filter open with this query and state. */
  filter?: { q: string; state: "all" | "running" | "waiting" };
  /** Draw the archived list in place of the conversations. */
  archived?: boolean;
};

/**
 * Sidebar props from the shared fixtures. `href(id)` gives the link of a nav item, extension page
 * or conversation id ("new" for New conversation).
 */
export function sidebarProps(o: SidebarFixture, href: (id: string) => string): SidebarProps {
  const level = o.level ?? "enterprise";
  const visible = NAV_FIXTURE.filter((n) => VISIBLE[level].includes(n.audience));
  const item = (n: FixtureNavItem): SidebarNavItem => ({
    id: n.id,
    label: n.label,
    href: href(n.id),
    icon: n.icon,
    ...(n.count !== undefined ? { count: n.count } : {}),
  });
  const inboxOf = (n: FixtureNavItem | undefined) =>
    n === undefined
      ? {}
      : { inbox: { href: href(n.id), ...(n.count !== undefined ? { count: n.count } : {}) } };
  const toGroup = (g: FixtureGroup): SidebarGroup => ({
    agentId: g.agentId,
    agentName: g.agentName,
    conversations: g.conversations.map((c) => ({
      id: c.id,
      title: o.activeTitle !== undefined && c.id === o.activeConversation ? o.activeTitle : c.title,
      startedAt: wallClock(c.startedAt),
      href: href(c.id),
      activity: c.activity ?? null,
    })),
    more: g.more,
    onMore: noop,
    onNew: noop,
  });
  const groups = o.archived
    ? GROUPS_FIXTURE.slice(1).map((g) => ({
        ...g,
        conversations: g.conversations.map(({ activity: _, ...c }) => c),
      }))
    : o.groups === "long"
      ? [LONG_TITLE_GROUP_FIXTURE, ...GROUPS_FIXTURE.slice(1)]
      : o.groups === "many"
        ? MANY_GROUPS_FIXTURE
        : GROUPS_FIXTURE;
  const filter = o.filter ?? { q: "", state: "all" as const };
  if (o.context === "setup") return setupSidebarProps(o, href);
  return {
    context:
      o.context === "admin"
        ? {
            kind: "admin",
            back: { href: href("overview"), slug: ORG_SWITCHER_FIXTURE.slug },
            items: ADMIN_NAV_FIXTURE.map((n) => ({ ...n, href: href(n.id) })),
          }
        : {
            kind: "work",
            org: { ...ORG_SWITCHER_FIXTURE, menu: [] },
            primary: visible.filter((n) => n.place === "primary").map(item),
            more: visible.filter((n) => n.place === "more").map(item),
            moreExtensions: EXTENSION_PAGES_FIXTURE.map((x) => ({
              id: `ext:${x.id}`,
              label: x.label,
              href: href(x.id),
              icon: "extension" as const,
            })),
            ...inboxOf(visible.find((n) => n.place === "brand")),
            ...(level === "enterprise" ? { adminHref: href("admin") } : {}),
          },
    newConversation: { href: href("new") },
    activeNav: o.active ?? "",
    conversations: {
      state: o.state === "loading" || o.state === "error" ? o.state : "ready",
      groups: o.state === undefined ? groups.map(toGroup) : [],
      ...(o.activeConversation ? { activeId: o.activeConversation } : {}),
      moreGroups: o.groups === "many" && MANY_GROUPS_MORE,
      onMoreGroups: noop,
      onRetry: noop,
      collapsed: o.collapsed ?? [],
      filter: { ...filter, onChange: noop },
      ...(o.filter ? { filterOpen: true } : {}),
      archived: { count: ARCHIVED_COUNT_FIXTURE, open: o.archived === true, onOpenChange: noop },
      onRename: done,
      onArchive: done,
      onDelete: done,
    },
    account: { name: FIXTURE_USER.name, menu: [] },
    ...(o.moreOpen ? { moreOpen: true } : {}),
    onOpenCommands: noop,
  };
}

/** The setup context (web-SSR spec §4): the setup home, the steps, no conversations. */
function setupSidebarProps(o: SidebarFixture, href: (id: string) => string): SidebarProps {
  const who = o.setup ?? "admin";
  return {
    context: {
      kind: "setup",
      org: { ...ORG_SWITCHER_FIXTURE, menu: [] },
      home: { href: href("home") },
      steps: setupStepsFixture(who, href),
      ...(who === "admin" ? { adminHref: href("admin") } : {}),
    },
    activeNav: o.active ?? "home",
    account: { name: FIXTURE_USER.name, menu: [] },
    onOpenCommands: noop,
  };
}

/** The setup steps of `who` with links (a waiting step has none). */
export function setupStepsFixture(
  who: "admin" | "member",
  href: (id: string) => string,
): SetupStep[] {
  return SETUP_STEPS_FIXTURE[who].map((s) =>
    s.state === "waiting" ? { ...s } : { ...s, href: href(s.id) },
  );
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
