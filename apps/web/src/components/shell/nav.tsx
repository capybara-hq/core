"use client";

import type {
  CommandGroup,
  DrawerNavData,
  IconName,
  NavBadge,
  SidebarNavItem,
} from "@capybara-hq/design";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useCallback } from "react";
import { useRouter } from "../../i18n/navigation";
import { adminInboxCountQuery } from "../../lib/query/admin";
import { retryOnMountOf } from "../../lib/query/client";
import { keys } from "../../lib/query/keys";
import { extensionPagesQuery, inboxCountQuery } from "../../lib/query/shell";
import { type UiCompactForm, type UiContributionItem, uiLocale } from "../../lib/ui";
import { ADMIN_PAGES, type AdminExtensionPage, type AdminPageId } from "../admin-nav";
import { useOfferedContributions } from "../extension-ui/ClientComponentBlock";

/**
 * Who sees a nav item: `all` everyone, `member` members and up (not guests), `admin` org admins
 * and owners. The admin console is for super admins (`me.account.isSuperAdmin`, apart
 * from the org role).
 */
type NavAudience = "all" | "member" | "admin";
/** 当前用户在当前组织里能看到哪一档导航项。 */
export type NavLevel = "guest" | "member" | "admin";

/**
 * The work context's navigation (web order §2.1, acceptance 2026-11-07): only routes that exist.
 * `primary` items follow New conversation (智能体, 技能, 连接器, 设备, 自动化; there is no home page: the new
 * conversation at `/` is the home, and `/chat` redirects there); `more` items sit in the 更多
 * flyout (then the extension pages). Search and the inbox are icon buttons in the brand row. Items are hidden
 * by the current org role through `audience` (cosmetic only; the kernel decides). The admin
 * console is the entry above the account row, for super admins. `drawer` places an item in the
 * compact drawer (design spec §6.53): a section entry or its "Skills, connectors, devices…" level; the
 * management items have none and never enter it (mobile layout spec §15, decision 4).
 */
const NAV: readonly {
  id: string;
  key: string;
  href: string;
  audience: NavAudience;
  icon: IconName;
  section: "primary" | "more";
  drawer?: "section" | "more";
  /** A management page that is desktop-only on touch: hidden there, never in the drawer. */
  desktopOnly?: true;
}[] = [
  {
    id: "agents",
    key: "agents",
    href: "/agents",
    audience: "all",
    icon: "agent",
    section: "primary",
    drawer: "section",
  },
  // Skills: members browse them, guests don't
  {
    id: "skills",
    key: "skills",
    href: "/skills",
    audience: "member",
    icon: "skills",
    section: "primary",
    drawer: "more",
  },
  {
    id: "connectors",
    key: "connectors",
    href: "/connectors",
    audience: "all",
    icon: "connector",
    section: "primary",
    drawer: "more",
  },
  // Automations: a member's own tasks (guests can't create them, spec §10)
  {
    id: "automations",
    key: "automations",
    href: "/automations",
    audience: "member",
    icon: "clock",
    section: "primary",
    drawer: "section",
  },
  // Devices: where a person's conversations run their commands and keep their files
  // (set up once, then rarely visited: under More)
  {
    id: "devices",
    key: "devices",
    href: "/devices",
    audience: "all",
    icon: "cpu",
    section: "more",
    drawer: "more",
  },
  // Plugins (what the platform offers this org): members browse and ask, org admins switch them
  {
    id: "plugins",
    key: "plugins",
    href: "/plugins",
    audience: "member",
    icon: "catalog",
    section: "more",
    desktopOnly: true,
  },
  // Extensions: members see their state (the kernel's org.extensions.read projection), org admins
  // also switch and configure them (org.extensions.manage)
  {
    id: "extensions",
    key: "extensions",
    href: "/extensions",
    audience: "member",
    icon: "extension",
    section: "more",
    desktopOnly: true,
  },
  {
    id: "channels",
    key: "channels",
    href: "/channels",
    audience: "admin",
    icon: "channel",
    section: "more",
    desktopOnly: true,
  },
  // Evals and runs: sets and runs (agent owners reach their runs from the agent page)
  {
    id: "evals",
    key: "evals",
    href: "/evals",
    audience: "admin",
    icon: "evals",
    section: "more",
    desktopOnly: true,
  },
  // Organization settings (members read General, Members and Sandbox; admins change them);
  // personal settings are the account menu's
  {
    id: "settings",
    key: "settings",
    href: "/settings/organization",
    audience: "member",
    icon: "settings",
    section: "more",
    desktopOnly: true,
  },
];

const VISIBLE: Record<NavLevel, readonly NavAudience[]> = {
  guest: ["all"],
  member: ["all", "member"],
  admin: ["all", "member", "admin"],
};

/** 当前组织里的导航档位（没有当前组织或角色未知时按访客）。 */
export function navLevelOf(me: {
  currentOrgId: string | null;
  memberships: { orgId: string; role: string }[];
}): NavLevel {
  const role = me.memberships.find((m) => m.orgId === me.currentOrgId)?.role;
  if (role === "owner" || role === "admin") return "admin";
  return role === "member" ? "member" : "guest";
}

/**
 * The `nav.*` message key naming the nav item `id`, or
 * undefined for an item without a nav label of its own: `new` (New conversation, labelled by the
 * design system), an extension page, none.
 */
export function navMessageKey(id: string): string | undefined {
  if (id === "inbox" || id === "admin") return id;
  return NAV.find((n) => n.id === id)?.key;
}

/** How often the inbox count is read again (in the browser; no server state involved). */
const PENDING_POLL_MS = 30_000;

const under = (pathname: string, prefix: string) =>
  pathname === prefix || pathname.startsWith(`${prefix}/`);

const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/**
 * The nav item the route belongs to: the new conversation (`/`, the home) is New conversation
 * (`new`), `/settings/*` is Organization settings, trajectories are Evals, an extension page
 * `/p/<plugin>/<id>` is its Extensions item `ext:<plugin>/<id>`; a conversation (`/chat/<id>`) is
 * none (its sidebar row is current instead).
 */
export function activeNavOf(pathname: string): string {
  if (pathname === "/") return "new";
  if (under(pathname, "/chat")) return "";
  const ext = /^\/p\/([^/]+)\/([^/]+)/.exec(pathname);
  if (ext?.[1] !== undefined && ext[2] !== undefined)
    return `ext:${decode(ext[1])}/${decode(ext[2])}`;
  if (under(pathname, "/settings")) return "settings";
  if (under(pathname, "/agents")) return "agents";
  if (under(pathname, "/skills")) return "skills";
  if (under(pathname, "/inbox")) return "inbox";
  if (under(pathname, "/channels")) return "channels";
  if (under(pathname, "/evals") || under(pathname, "/trajectories")) return "evals";
  if (under(pathname, "/admin")) return "admin";
  if (under(pathname, "/plugins")) return "plugins";
  if (under(pathname, "/extensions")) return "extensions";
  if (under(pathname, "/connectors")) return "connectors";
  if (under(pathname, "/devices")) return "devices";
  if (under(pathname, "/automations")) return "automations";
  return "";
}

/**
 * The current user's pending inbox count (`GET /inbox`: tool approvals and skill changes) from the
 * query cache: read again every 30 s, on a path change while stale (AppFrame) and on `refresh()`;
 * 0 while it loads or when the read fails. `more`: the inbox was truncated (more than `count`
 * items).
 */
export function usePendingApprovals(orgId: string): {
  count: number;
  more: boolean;
  refresh(): void;
} {
  const qc = useQueryClient();
  const query = inboxCountQuery(orgId);
  const { data } = useQuery({
    ...query,
    retryOnMount: retryOnMountOf(query.queryKey),
    refetchInterval: PENDING_POLL_MS,
  });
  const refresh = useCallback(
    () => void qc.invalidateQueries({ queryKey: keys.org(orgId).inboxCount() }),
    [qc, orgId],
  );
  return { count: data?.count ?? 0, more: data?.more ?? false, refresh };
}

/**
 * The super admin's inbox count for the admin sidebar's 收件箱 item (`GET /admin/inbox/count`, a
 * number rather than the page's items, so it is not capped at the page's 100): read again every
 * 30 s while `enabled` (under `/admin`); undefined while it loads, when the read failed or when not
 * enabled. The sidebar draws a count above 99 as `99+`.
 */
export function useAdminInboxCount(enabled: boolean): number | undefined {
  const query = adminInboxCountQuery();
  const { data } = useQuery({
    ...query,
    enabled,
    retryOnMount: retryOnMountOf(query.queryKey),
    refetchInterval: enabled ? PENDING_POLL_MS : false,
  });
  return enabled ? data?.total : undefined;
}

/** 插件页面的路由：`/p/<插件>/<贡献 id>`。 */
export const pluginPageHref = (plugin: string, id: string) =>
  `/p/${encodeURIComponent(plugin)}/${encodeURIComponent(id)}`;

/** An extension page of the Extensions group; `compact` `hidden`: not listed on the compact class. */
export type ExtensionNavItem = {
  id: string;
  label: string;
  href: string;
  compact: UiCompactForm;
};

/**
 * The entries a compact list shows: the drawer is the compact class's navigation, so a page whose
 * compact form is `hidden` is left out of it (the wide sidebar lists every page).
 */
export const shownOnCompact = <T extends { compact?: UiCompactForm }>(items: readonly T[]): T[] =>
  items.filter((i) => i.compact !== "hidden");

/**
 * The sidebar's Extensions group: the page contributions (slot `org.page`) of the current org's
 * enabled extensions, schema views, embeds and client components, labelled by the page title; when
 * two pages share a title, each label gets its plugin name. A component page is listed only while
 * its code may run (not in safe mode, under the kill switch or after the crash budget). Empty
 * while loading, without pages or on a failed read (the group is then hidden).
 */
export function useExtensions(orgId: string, locale: string): ExtensionNavItem[] {
  const query = extensionPagesQuery(orgId);
  const pages =
    useQuery({ ...query, retryOnMount: retryOnMountOf(query.queryKey) }).data ?? NO_PAGES;
  return extensionItems(useOfferedContributions(pages), locale);
}

const NO_PAGES: UiContributionItem[] = [];

/** The Extensions group's items for `pages`. */
function extensionItems(pages: readonly UiContributionItem[], locale: string): ExtensionNavItem[] {
  const lang = uiLocale(locale);
  const titles = pages.map((p) => p.title[lang]);
  return pages.map((p) => {
    const title = p.title[lang];
    const shared = titles.filter((x) => x === title).length > 1;
    return {
      id: `${p.plugin}/${p.id}`,
      label: shared ? `${title} · ${p.plugin}` : title,
      href: pluginPageHref(p.plugin, p.id),
      compact: p.compact ?? "kept",
    };
  });
}

/**
 * The status bar prompt (web order §2.3, spec §4.4): `<login>@<org-slug>:<path>`, the path `~` +
 * the pathname in the workspace and the pathname as-is under `/admin`; without a current org there
 * is no `@<slug>`. The login is the account's name in lowercase, spaces joined by hyphens (`/me`
 * carries no login name, and an SSO account may have none).
 */
export function statusPrompt(login: string, slug: string | null, pathname: string): string {
  const path = under(pathname, "/admin") ? pathname : `~${pathname === "/" ? "" : pathname}`;
  const user = login.trim().toLowerCase().replace(/\s+/g, "-");
  return `${user}${slug === null ? "" : `@${slug}`}:${path}`;
}

const ADMIN_ICONS: Record<AdminPageId, IconName> = {
  overview: "gauge",
  inbox: "inbox",
  audit: "file-text",
  accounts: "user",
  orgs: "building",
  plugins: "catalog",
  extensions: "extension",
  skills: "skills",
  connectors: "connector",
  themes: "image",
  agents: "agent",
  models: "cpu",
  settings: "sliders",
};

/**
 * The admin context's items (web order §2.2), from the admin pages. `counts` puts a count on an
 * item: 收件箱 shows what waits on the platform, 插件 what waits in its 待确认 tab (spec §9).
 */
export function useAdminItems(
  counts: Partial<Record<AdminPageId, number | undefined>> = {},
  /** The extensions' platform pages (`platform.page`), listed after the fixed pages. */
  pages: readonly AdminExtensionPage[] = [],
): SidebarNavItem[] {
  const t = useTranslations("admin.nav");
  return [
    ...ADMIN_PAGES.map((p) => {
      const count = counts[p.id];
      return {
        id: p.id,
        label: t(p.id),
        href: p.href,
        icon: ADMIN_ICONS[p.id],
        ...(count !== undefined && count > 0 ? { count } : {}),
      };
    }),
    ...pages.map((p) => ({ ...p, id: `ext:${p.id}`, icon: "extension" as const })),
  ];
}

/** The admin item a route belongs to: the longest matching href (`/admin` only by itself). */
export function activeAdminOf(pathname: string, items: { id: string; href: string }[]): string {
  const hit = items
    .filter((i) => (i.href === "/admin" ? pathname === i.href : under(pathname, i.href)))
    .sort((a, b) => b.href.length - a.href.length)[0];
  return hit?.id ?? "";
}

/**
 * The work context's navigation (primary items, 更多, the admin entry) and the command palette.
 * `superAdmin`: the account is a super admin, so the admin entry shows (cosmetic;
 * `/api/v1/admin/*` is decided by the kernel).
 */
export function useNav(
  pending = 0,
  level: NavLevel = "guest",
  pendingMore = false,
  superAdmin = false,
): {
  primary: SidebarNavItem[];
  more: SidebarNavItem[];
  /** The brand row's inbox button (count only while something is pending). */
  inbox: { href: string; count?: number; countMore?: boolean };
  adminHref?: string;
  commands: CommandGroup[];
} {
  const t = useTranslations();
  const router = useRouter();
  const items = NAV.filter((n) => VISIBLE[level].includes(n.audience)).map((n) => ({
    section: n.section,
    id: n.id,
    label: t(`nav.${n.key}`),
    href: n.href,
    icon: n.icon,
    ...(n.desktopOnly ? { desktopOnly: true } : {}),
  }));
  const inbox = {
    href: "/inbox",
    ...(pending > 0 ? { count: pending, ...(pendingMore ? { countMore: true } : {}) } : {}),
  };
  const strip = ({ section: _, ...item }: (typeof items)[number]): SidebarNavItem => item;
  const primary = items.filter((n) => n.section === "primary").map(strip);
  const more = items.filter((n) => n.section === "more").map(strip);
  const admin = superAdmin
    ? [{ id: "admin", label: t("nav.admin"), href: "/admin", desktopOnly: true }]
    : [];
  const commands: CommandGroup[] = [
    {
      label: t("nav.goto"),
      items: [
        ...primary,
        { id: "inbox", label: t("nav.inbox"), href: inbox.href },
        // the conversations page: with the native strip the drawer's All conversations is not
        // on screen
        { id: "conversations", label: t("drawer.allConversations"), href: "/conversations" },
        ...more,
        ...admin,
      ].map((n) => ({
        id: `goto-${n.id}`,
        label: n.label,
        ...("desktopOnly" in n && n.desktopOnly ? { desktopOnly: true } : {}),
        onSelect: () => router.push(n.href),
      })),
    },
    {
      label: t("nav.actions"),
      // agents.create is for members up; installing a connector (connectors.manage) for org admins
      items: [
        ...(level !== "guest"
          ? [
              {
                id: "new-agent",
                label: t("agents.new"),
                onSelect: () => router.push("/agents/new"),
              },
            ]
          : []),
        ...(level === "admin"
          ? [
              {
                id: "new-app",
                label: t("connectors.new"),
                onSelect: () => router.push("/connectors/install"),
              },
            ]
          : []),
      ],
    },
  ].filter((g) => g.items.length > 0);
  return {
    primary,
    more,
    inbox,
    ...(superAdmin ? { adminHref: "/admin" } : {}),
    commands,
  };
}

/** What the compact drawer takes from the navigation (design spec §6.53). */
export type DrawerNav = Pick<
  DrawerNavData,
  "sections" | "more" | "moreLabel" | "allConversations" | "newConversation"
> & { menuBadge?: NavBadge };

/**
 * The compact drawer's navigation (design spec §6.53; mobile touch plan Task 28) from the same
 * `NAV` data and role levels as the sidebar: the sections Inbox (with the pending count), Agents
 * and Automations, and the "Skills, connectors, devices…" level with Skills, Connectors, Devices
 * and the org's extension pages (those not hidden on compact). The management items (Plugins,
 * Extensions, Channels, Evals & runs, Organization settings, the admin console) never enter it: on touch they are managed on a computer.
 */
export function useDrawerNav(
  level: NavLevel,
  pending: { count: number; more: boolean } = { count: 0, more: false },
  extensions: readonly ExtensionNavItem[] = [],
): DrawerNav {
  const t = useTranslations();
  const visible = NAV.filter((n) => VISIBLE[level].includes(n.audience));
  const badge: NavBadge | undefined =
    pending.count > 0
      ? { count: pending.count, ...(pending.more ? { more: true } : {}) }
      : undefined;
  const item = (n: (typeof NAV)[number]) => ({
    label: t(`nav.${n.key}`),
    href: n.href,
    icon: n.icon,
  });
  const sections: DrawerNav["sections"] = [
    {
      id: "inbox",
      label: t("nav.inbox"),
      href: "/inbox",
      icon: "inbox",
      ...(badge ? { badge } : {}),
    },
    ...visible
      .filter((n) => n.drawer === "section")
      .map((n) => ({ id: n.id as "agents" | "automations", ...item(n) })),
  ];
  const more: DrawerNav["more"] = [
    ...visible.filter((n) => n.drawer === "more").map((n) => ({ id: n.id, ...item(n) })),
    ...shownOnCompact(extensions).map((x) => ({
      id: `ext:${x.id}`,
      label: x.label,
      href: x.href,
      icon: "extension" as const,
    })),
  ];
  return {
    sections,
    more,
    moreLabel: t("drawer.more"),
    allConversations: { label: t("drawer.allConversations"), href: "/conversations" },
    newConversation: { label: t("conversations.new"), href: "/" },
    ...(badge ? { menuBadge: badge } : {}),
  };
}
