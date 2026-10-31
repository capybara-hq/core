"use client";

import type { CommandGroup, IconName, SidebarNavItem } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "../../i18n/navigation";
import { listInbox } from "../../lib/inbox";
import { listUiContributions, type UiContributionItem, uiLocale } from "../../lib/ui";
import { ADMIN_PAGES, type AdminPageId } from "../admin-nav";

/**
 * Who sees a nav item: `all` everyone, `member` members and up (not guests), `admin` org admins
 * and owners. The admin console is for enterprise admins (`me.account.isEnterpriseAdmin`, apart
 * from the org role).
 */
type NavAudience = "all" | "member" | "admin";
/** 当前用户在当前组织里能看到哪一档导航项。 */
export type NavLevel = "guest" | "member" | "admin";

/**
 * The work context's navigation (web order §2.1): only routes that exist. `primary` items follow
 * New conversation and Search; `more` items sit in the collapsible 更多 group (then the extension
 * pages). Items are hidden by the current org role through `audience` (cosmetic only; the kernel
 * decides). The admin console is the entry above the account row, for enterprise admins.
 */
const NAV: readonly {
  id: string;
  key: string;
  href: string;
  audience: NavAudience;
  icon: IconName;
  section: "primary" | "more";
}[] = [
  { id: "overview", key: "overview", href: "/", audience: "all", icon: "home", section: "primary" },
  { id: "inbox", key: "inbox", href: "/inbox", audience: "all", icon: "inbox", section: "primary" },
  {
    id: "agents",
    key: "agents",
    href: "/agents",
    audience: "all",
    icon: "agent",
    section: "primary",
  },
  // Skills: members browse them, guests don't
  {
    id: "skills",
    key: "skills",
    href: "/skills",
    audience: "member",
    icon: "skills",
    section: "more",
  },
  {
    id: "connectors",
    key: "connectors",
    href: "/connectors",
    audience: "all",
    icon: "connector",
    section: "more",
  },
  // Plugins (the org's catalog view): members browse and request, org admins install
  {
    id: "catalog",
    key: "catalog",
    href: "/catalog",
    audience: "member",
    icon: "catalog",
    section: "more",
  },
  {
    id: "channels",
    key: "channels",
    href: "/channels",
    audience: "admin",
    icon: "channel",
    section: "more",
  },
  // Evals and runs: sets and runs (agent owners reach their runs from the agent page)
  { id: "evals", key: "evals", href: "/evals", audience: "admin", icon: "evals", section: "more" },
  // Organization settings; personal settings are the account menu's
  {
    id: "settings",
    key: "settings",
    href: "/settings/organization",
    audience: "admin",
    icon: "settings",
    section: "more",
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

/** 收件箱待处理数的刷新间隔（浏览器内轮询，不涉及服务端状态）。 */
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
 * The nav item the route belongs to: `/settings/*` is Organization settings, trajectories are Evals, an
 * extension page `/p/<plugin>/<id>` is its Extensions item `ext:<plugin>/<id>`; a conversation
 * (`/chat/*`) is none (its sidebar row is current instead).
 */
export function activeNavOf(pathname: string): string {
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
  if (under(pathname, "/catalog")) return "catalog";
  if (under(pathname, "/connectors")) return "connectors";
  return pathname === "/" ? "overview" : "";
}

/**
 * 当前用户收件箱里的待处理数（`GET /inbox`：工具审批 + 技能变更）：组织或路由变化时、每 30 秒、以及调用
 * `refresh()` 时重读；没有当前组织或读取失败时为 0。`more`：收件箱被截断（实际不止 `count` 项）。
 */
export function usePendingApprovals(
  orgId: string | null,
  pathname: string,
): { count: number; more: boolean; refresh(): void } {
  const [count, setCount] = useState(0);
  const [more, setMore] = useState(false);
  const [nonce, setNonce] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname 与 nonce 只用于触发重读
  useEffect(() => {
    if (orgId === null) {
      setCount(0);
      return;
    }
    let disposed = false;
    const load = () =>
      listInbox(orgId).then(
        (r) => {
          if (disposed) return;
          setCount(r.items.length);
          setMore(r.truncated === true);
        },
        () => {
          if (disposed) return;
          setCount(0);
          setMore(false);
        },
      );
    void load();
    const timer = setInterval(() => void load(), PENDING_POLL_MS);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [orgId, pathname, nonce]);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  return { count, more, refresh };
}

/** 插件页面的路由：`/p/<插件>/<贡献 id>`。 */
export const pluginPageHref = (plugin: string, id: string) =>
  `/p/${encodeURIComponent(plugin)}/${encodeURIComponent(id)}`;

/**
 * The sidebar's Extensions group: the page contributions (`place: "page"`) of the current org's
 * enabled extensions, schema views and embeds alike, labelled by the page title; when two pages
 * share a title, each label gets its plugin name. Empty without an org, pages or on a failed read
 * (the group is then hidden).
 */
export function useExtensions(
  orgId: string | null,
  locale: string,
): { id: string; label: string; href: string }[] {
  const [pages, setPages] = useState<UiContributionItem[]>([]);
  useEffect(() => {
    if (orgId === null) {
      setPages([]);
      return;
    }
    let disposed = false;
    listUiContributions(orgId).then(
      ({ items }) => {
        if (!disposed) setPages(items.filter((c) => c.place === "page"));
      },
      () => {
        if (!disposed) setPages([]);
      },
    );
    return () => {
      disposed = true;
    };
  }, [orgId]);
  const lang = uiLocale(locale);
  const titles = pages.map((p) => p.title[lang]);
  return pages.map((p) => {
    const title = p.title[lang];
    const shared = titles.filter((x) => x === title).length > 1;
    return {
      id: `${p.plugin}/${p.id}`,
      label: shared ? `${title} · ${p.plugin}` : title,
      href: pluginPageHref(p.plugin, p.id),
    };
  });
}

/**
 * The status bar prompt (web order §2.3): `<login>@<org-slug>:<path>`, the path `~` + the
 * pathname in the workspace and the pathname as-is under `/admin`; without a current org there
 * is no `@<slug>`.
 */
export function statusPrompt(login: string, slug: string | null, pathname: string): string {
  const path = under(pathname, "/admin") ? pathname : `~${pathname === "/" ? "" : pathname}`;
  return `${login}${slug === null ? "" : `@${slug}`}:${path}`;
}

const ADMIN_ICONS: Record<AdminPageId, IconName> = {
  overview: "gauge",
  accounts: "user",
  orgs: "building",
  extensions: "extension",
  catalog: "catalog",
  marketplaces: "store",
  models: "cpu",
  settings: "sliders",
};

/** The admin context's items (web order §2.2), from the admin pages. */
export function useAdminItems(): SidebarNavItem[] {
  const t = useTranslations("admin.nav");
  return ADMIN_PAGES.map((p) => ({
    id: p.id,
    label: t(p.id),
    href: p.href,
    icon: ADMIN_ICONS[p.id],
  }));
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
 * `enterpriseAdmin`: the account is an enterprise admin, so the admin entry shows (cosmetic;
 * `/api/v1/admin/*` is decided by the kernel).
 */
export function useNav(
  pending = 0,
  level: NavLevel = "guest",
  pendingMore = false,
  enterpriseAdmin = false,
): {
  primary: SidebarNavItem[];
  more: SidebarNavItem[];
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
    ...(n.id === "inbox" && pending > 0
      ? { count: pending, ...(pendingMore ? { countMore: true } : {}) }
      : {}),
  }));
  const strip = ({ section: _, ...item }: (typeof items)[number]): SidebarNavItem => item;
  const primary = items.filter((n) => n.section === "primary").map(strip);
  const more = items.filter((n) => n.section === "more").map(strip);
  const admin = enterpriseAdmin ? [{ id: "admin", label: t("nav.admin"), href: "/admin" }] : [];
  const commands: CommandGroup[] = [
    {
      label: t("nav.goto"),
      items: [...primary, ...more, ...admin].map((n) => ({
        id: `goto-${n.id}`,
        label: n.label,
        onSelect: () => router.push(n.href),
      })),
    },
    {
      label: t("nav.actions"),
      items: [
        { id: "new-agent", label: t("agents.new"), onSelect: () => router.push("/agents/new") },
        {
          id: "new-app",
          label: t("connectors.new"),
          onSelect: () => router.push("/connectors/install"),
        },
      ],
    },
  ];
  return { primary, more, ...(enterpriseAdmin ? { adminHref: "/admin" } : {}), commands };
}
