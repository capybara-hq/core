"use client";

import {
  AppShell,
  Button,
  type IconName,
  type MenuItem,
  type SidebarContext,
  type SidebarFilter,
  type SidebarNavItem,
  StatusPage,
  useToast,
} from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { usePathname, useRouter } from "../../i18n/navigation";
import { ApiClientError } from "../../lib/api";
import { loginPathFor } from "../../lib/auth-sources";
import { useConnectResultToast } from "../../lib/connect";
import {
  deleteConversation,
  notifyConversationsChanged,
  renameConversation,
  setConversationArchived,
} from "../../lib/conversations";
import { usePreferences } from "../../lib/preferences";
import { getMe, logout, type Me, setCurrentOrg } from "../../lib/session";
import { useErrorMessage } from "../../lib/use-error-message";
import { type AdminPageId, useAdminNav } from "../admin-nav";
import { CreateOrgDialog } from "../CreateOrgDialog";
import { useConversationGroups } from "./conversations";
import {
  activeNavOf,
  navLevelOf,
  routeLabel,
  useExtensions,
  useNav,
  usePendingApprovals,
} from "./nav";
import { OrgChooser } from "./OrgChooser";
import { type Session, SessionContext } from "./session";

/** 本地时区，如 `UTC+8`、`UTC-3:30`（StatusBar 右侧，spec §4.4）。 */
function timeZoneLabel(): string {
  const offset = -new Date().getTimezoneOffset();
  const sign = offset < 0 ? "-" : "+";
  const h = Math.floor(Math.abs(offset) / 60);
  const m = Math.abs(offset) % 60;
  return `UTC${sign}${h}${m === 0 ? "" : `:${String(m).padStart(2, "0")}`}`;
}

const noSubscribe = () => () => {};

/** The work context's primary items after New conversation and Search (web-order spec §2.1). */
const PRIMARY = ["overview", "inbox", "agents"];

const ADMIN_ICONS: Record<AdminPageId, IconName> = {
  overview: "gauge",
  accounts: "user",
  orgs: "building",
  extensions: "extension",
  catalog: "catalog",
  models: "cpu",
  settings: "sliders",
};

/** The admin item a route belongs to: the longest matching href (`/admin` only by itself). */
function activeAdminOf(pathname: string, items: { id: string; href: string }[]): string {
  const hit = items
    .filter((i) =>
      i.href === "/admin"
        ? pathname === i.href
        : pathname === i.href || pathname.startsWith(`${i.href}/`),
    )
    .sort((a, b) => b.href.length - a.href.length)[0];
  return hit?.id ?? "";
}

/**
 * 浏览器时区：服务端与水合时的首次渲染为空串（服务器时区与用户的不同，避免水合不一致），
 * 水合后取浏览器的值。
 */
function useTimeZoneLabel(): string {
  return useSyncExternalStore(noSubscribe, timeZoneLabel, () => "");
}

/**
 * The (app) route group's frame: reads `GET /api/v1/me` (401 → sign-in), provides it to pages
 * through {@link SessionContext}, and renders the App Shell: the sidebar (navigation, extension
 * pages, my conversations grouped by agent, the account menu with the org switch, language, theme
 * and sign out) and the status bar (`account@org:route` · version · time zone). Pages that need
 * the session wait for it.
 */
export function AppFrame({ version, children }: { version: string; children: ReactNode }) {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  // 回跳路径只在读取 /me 失败时取；换路由不应重读 /me，所以不放进 load 的依赖
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;
  const errorMessage = useErrorMessage();
  const toast = useToast();
  const [me, setMe] = useState<Me>();
  // undefined while /me loads (the section shows its skeleton), null when there is no current org
  const conversations = useConversationGroups(
    me === undefined ? undefined : me.currentOrgId,
    pathname,
    { onError: (e) => toast.error(errorMessage(e)) },
  );
  const pending = usePendingApprovals(me?.currentOrgId ?? null, pathname);
  const { nav, footerNav, commands } = useNav(
    pending.count,
    me === undefined ? "guest" : navLevelOf(me),
    pending.more,
    me?.account.isEnterpriseAdmin === true,
  );
  const extensions = useExtensions(me?.currentOrgId ?? null, locale);
  const adminNav = useAdminNav();
  // The conversation filter; Task 6 passes it to the kernel (`?q=`, `?state=`).
  const [filter, setFilter] = useState<SidebarFilter>({ q: "", state: "all" });
  const [error, setError] = useState<string>();
  const preferences = usePreferences();
  const [creatingOrg, setCreatingOrg] = useState(false);
  const timeZone = useTimeZoneLabel();
  useConnectResultToast();

  const load = useCallback(async () => {
    try {
      setMe(await getMe());
      setError(undefined);
    } catch (e) {
      // 未登录：去登录页，登录后回到当前页
      if (e instanceof ApiClientError && e.status === 401)
        router.replace(loginPathFor(`${pathnameRef.current}${window.location.search}`));
      else setError(errorMessage(e));
    }
  }, [router, errorMessage]);

  useEffect(() => {
    void load();
  }, [load]);

  const switchOrg = useCallback(
    async (orgId: string | null) => {
      try {
        await setCurrentOrg(orgId);
        // 会话属于原组织：先回到列表，再换会话（对话页也不会以新组织 + 旧会话渲染，见 chat 页）
        if (pathname.startsWith("/chat")) router.push("/agents");
        // 连接器详情同理：连接器属于原组织
        else if (pathname.startsWith("/connectors/") && pathname !== "/connectors/install")
          router.push("/connectors");
        // 这里直接读 /me 而不走 load：刷新失败要以 toast 告知，而不是被 load 吞掉
        setMe(await getMe());
        setError(undefined);
      } catch (e) {
        if (e instanceof ApiClientError && e.status === 401) router.replace("/login");
        else toast.error(errorMessage(e));
      }
    },
    [pathname, router, toast, errorMessage],
  );

  const session = useMemo<Session | undefined>(
    () =>
      me === undefined
        ? undefined
        : { me, reload: load, switchOrg, refreshPending: pending.refresh, version },
    [me, load, switchOrg, pending.refresh, version],
  );

  async function onLogout() {
    try {
      await logout();
    } finally {
      router.replace("/login");
    }
  }

  const currentOrg = me?.memberships.find((m) => m.orgId === me.currentOrgId);
  // The account menu: Organization ▸ (the current one checked) and Language ▸ above sign-out; the
  // theme is the switch after the account (spec §6.13).
  const createOrgItem: MenuItem[] = me?.canCreateOrg
    ? [{ label: t("shell.createOrg"), onSelect: () => setCreatingOrg(true) }]
    : [];
  // The user's orgs as radio items, then "Create organization…": the org switcher's menu and the
  // account menu's Organization submenu.
  const orgItems: MenuItem[] =
    me === undefined
      ? []
      : [
          ...me.memberships.map((m) => ({
            label: m.name,
            checked: m.orgId === me.currentOrgId,
            disabled: m.orgId === me.currentOrgId,
            onSelect: () => void switchOrg(m.orgId),
          })),
          ...(me.memberships.length > 0 && createOrgItem.length > 0 ? ["separator" as const] : []),
          ...createOrgItem,
        ];
  const orgMenu: MenuItem[] =
    me === undefined || (me.memberships.length === 0 && !me.canCreateOrg)
      ? []
      : [{ label: t("shell.orgMenu"), submenu: orgItems }];
  const languageMenu: MenuItem = {
    label: preferences.language.label,
    submenu: preferences.language.options.map((o) => ({
      label: o.label,
      checked: o.value === preferences.language.value,
      onSelect: () => preferences.language.onChange(o.value),
    })),
  };
  const accountMenu: MenuItem[] = [
    ...orgMenu,
    languageMenu,
    "separator",
    { label: t("common.logout"), onSelect: () => void onLogout() },
  ];
  // A minimal adapter onto Sidebar v3 (Task 6 does the real wiring): today's nav split into the
  // primary items and 更多 (then the extension pages); Admin becomes the entry above the account.
  const inAdmin = pathname === "/admin" || pathname.startsWith("/admin/");
  const adminItems: SidebarNavItem[] = adminNav
    .flatMap((g) => g.items)
    .map((i) => ({ ...i, icon: ADMIN_ICONS[i.id] }));
  const adminHref = footerNav.find((n) => n.id === "admin")?.href;
  const roles: Record<string, string> = {
    owner: t("members.roles.owner"),
    admin: t("members.roles.admin"),
    member: t("members.roles.member"),
    guest: t("members.roles.guest"),
  };
  const context: SidebarContext = inAdmin
    ? {
        kind: "admin",
        back: { href: "/", slug: currentOrg?.slug ?? null },
        items: adminItems,
      }
    : {
        kind: "work",
        org: currentOrg
          ? {
              name: currentOrg.name,
              initial: (Array.from(currentOrg.name)[0] ?? "").toUpperCase(),
              slug: currentOrg.slug,
              role: roles[currentOrg.role] ?? currentOrg.role,
              menu: orgItems,
            }
          : null,
        primary: PRIMARY.flatMap((id) => nav.filter((n) => n.id === id)),
        more: [
          ...nav.filter((n) => !PRIMARY.includes(n.id)),
          ...footerNav.filter((n) => n.id !== "admin"),
          ...extensions.map((x) => ({ ...x, id: `ext:${x.id}`, icon: "extension" as const })),
        ],
        ...(adminHref === undefined ? {} : { adminHref }),
      };
  const orgId = me?.currentOrgId ?? null;
  // The row actions: the kernel calls, then the list refreshes; a failure is a toast.
  const act = async (call: () => Promise<unknown>, rethrow: boolean) => {
    if (orgId === null) return;
    try {
      await call();
      notifyConversationsChanged();
    } catch (e) {
      toast.error(errorMessage(e));
      if (rethrow) throw e;
    }
  };
  const sidebar = {
    context,
    // A new conversation starts at the composer; nothing is created before the first send.
    newConversation: { href: "/chat" },
    activeNav: inAdmin ? activeAdminOf(pathname, adminItems) : activeNavOf(pathname),
    conversations: {
      ...conversations,
      filter: { ...filter, onChange: setFilter },
      // The archived list is wired in the shell task.
      archived: { count: 0, open: false, onOpenChange: () => {} },
      onRename: (id: string, title: string) =>
        act(() => renameConversation(orgId ?? "", id, title), true),
      onArchive: (id: string, archived: boolean) =>
        act(() => setConversationArchived(orgId ?? "", id, archived), false),
      onDelete: (id: string) => act(() => deleteConversation(orgId ?? "", id), true),
    },
    account: {
      name: me === undefined ? t("common.loading") : me.account.displayName,
      menu: me === undefined ? [] : accountMenu,
    },
    theme: preferences.theme,
  };
  const who =
    me === undefined ? "" : `${me.account.displayName}${currentOrg ? `@${currentOrg.name}` : ""}`;
  const status = {
    // 会话加载前不显示上下文路径
    context: me === undefined ? "" : `${who}:${routeLabel(pathname)}`,
    version,
    ...(timeZone === "" ? {} : { timeZone }),
  };

  // 会话由页面内的 RequireSession 等待；不需要会话的内容（如 404）在服务端即可渲染。
  const body: ReactNode =
    error !== undefined && session === undefined ? (
      <StatusPage
        header={{ path: [{ label: "~" }], title: t("common.loadFailed") }}
        kind="maintenance"
        title={t("common.loadFailed")}
        description={error}
        action={
          <Button variant="primary" onClick={() => void load()}>
            {t("common.retry")}
          </Button>
        }
      />
    ) : (
      <SessionContext.Provider value={session ?? null}>
        {children}
        {session?.me.canCreateOrg ? (
          <CreateOrgDialog open={creatingOrg} onOpenChange={setCreatingOrg} />
        ) : null}
      </SessionContext.Provider>
    );

  // Signed in without a current org: the chooser covers the whole shell (the admin console, which
  // needs no org, stays reachable for enterprise admins).
  if (session !== undefined && session.me.currentOrgId === null && !pathname.startsWith("/admin")) {
    return (
      <SessionContext.Provider value={session}>
        <OrgChooser onLogout={() => void onLogout()} />
      </SessionContext.Provider>
    );
  }

  return (
    // The conversation page draws its own status bar under its middle column (spec §5.2).
    <AppShell
      sidebar={sidebar}
      commands={commands}
      status={status}
      ownStatusBar={pathname === "/chat" || pathname.startsWith("/chat/")}
    >
      {body}
    </AppShell>
  );
}
