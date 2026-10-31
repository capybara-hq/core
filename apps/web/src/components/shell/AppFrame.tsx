"use client";

import {
  AppShell,
  Button,
  initialOf,
  type MenuItem,
  PendingState,
  SetupPage,
  type SidebarContext,
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
import { NoCurrentOrgError } from "../../lib/conversations";
import { usePreferences } from "../../lib/preferences";
import { getMe, logout, type Me, setCurrentOrg } from "../../lib/session";
import { useErrorMessage } from "../../lib/use-error-message";
import { CreateOrgDialog } from "../CreateOrgDialog";
import { useConversationGroups } from "./conversations";
import {
  activeAdminOf,
  activeNavOf,
  navLevelOf,
  statusPrompt,
  useAdminItems,
  useExtensions,
  useNav,
  usePendingApprovals,
} from "./nav";
import { OrgChooser } from "./OrgChooser";
import { type Session, SessionContext } from "./session";
import { SetupContext, SetupHome, setupRouteOf, useReadiness } from "./setup";

/** 本地时区，如 `UTC+8`、`UTC-3:30`（StatusBar 右侧，spec §4.4）。 */
function timeZoneLabel(): string {
  const offset = -new Date().getTimezoneOffset();
  const sign = offset < 0 ? "-" : "+";
  const h = Math.floor(Math.abs(offset) / 60);
  const m = Math.abs(offset) % 60;
  return `UTC${sign}${h}${m === 0 ? "" : `:${String(m).padStart(2, "0")}`}`;
}

const noSubscribe = () => () => {};

/**
 * 浏览器时区：服务端与水合时的首次渲染为空串（服务器时区与用户的不同，避免水合不一致），
 * 水合后取浏览器的值。
 */
function useTimeZoneLabel(): string {
  return useSyncExternalStore(noSubscribe, timeZoneLabel, () => "");
}

/**
 * The (app) route group's frame: reads `GET /api/v1/me` (401 → sign-in), provides it to pages
 * through {@link SessionContext}, and renders the App Shell: the sidebar in one of its two
 * contexts (web order §2.1–§2.2: the workspace with the org switcher, navigation, 更多 with the
 * extension pages and my conversations; or the admin console under `/admin`), the account menu
 * (org switch, language, personal settings, sign out) and the status bar
 * (`<login>@<slug>:<path>` · version · time zone). Pages that need the session wait for it.
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
    {
      onError: (e) =>
        toast.error(e instanceof NoCurrentOrgError ? t("shell.noCurrentOrg") : errorMessage(e)),
    },
  );
  const pending = usePendingApprovals(me?.currentOrgId ?? null, pathname);
  const { primary, more, inbox, adminHref, commands } = useNav(
    pending.count,
    me === undefined ? "guest" : navLevelOf(me),
    pending.more,
    me?.account.isEnterpriseAdmin === true,
  );
  const extensions = useExtensions(me?.currentOrgId ?? null, locale);
  const adminItems = useAdminItems();
  const [error, setError] = useState<string>();
  const preferences = usePreferences();
  const [creatingOrg, setCreatingOrg] = useState(false);
  const timeZone = useTimeZoneLabel();
  useConnectResultToast();
  // The setup layout (web-order spec §3.8): while the org lacks a model or an agent, workspace
  // routes render in it instead of the shell; the layout is decided before anything is painted.
  const setupRoute = setupRouteOf(pathname);
  const readiness = useReadiness(me === undefined ? undefined : me.currentOrgId, pathname);
  const inSetup = setupRoute !== "outside" && readiness.state.kind === "setup";
  useEffect(() => {
    if (inSetup && setupRoute === "redirect") router.replace("/");
  }, [inSetup, setupRoute, router]);

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
  // The account menu (web order §2.1): Organization ▸ (the current one checked), Language ▸,
  // Personal settings, sign out; the theme is the switch after the account.
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
    { label: t("shell.accountSettings"), href: "/account/connections" },
    "separator",
    { label: t("common.logout"), onSelect: () => void onLogout() },
  ];
  // The admin context under /admin (web order §2.2), else the workspace of the current org. Only
  // for an enterprise admin: anyone else gets the 403 beside the workspace sidebar.
  const inAdmin =
    me?.account.isEnterpriseAdmin === true &&
    (pathname === "/admin" || pathname.startsWith("/admin/"));
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
              initial: initialOf(currentOrg.name),
              slug: currentOrg.slug,
              role: roles[currentOrg.role] ?? currentOrg.role,
              menu: orgItems,
            }
          : null,
        primary,
        more,
        moreExtensions: extensions.map((x) => ({
          ...x,
          id: `ext:${x.id}`,
          icon: "extension" as const,
        })),
        inbox,
        ...(adminHref === undefined ? {} : { adminHref }),
      };
  const sidebar = {
    context,
    // A new conversation starts at the composer; nothing is created before the first send.
    newConversation: { href: "/chat" },
    activeNav: inAdmin ? activeAdminOf(pathname, adminItems) : activeNavOf(pathname),
    conversations,
    account: {
      name: me === undefined ? t("common.loading") : me.account.displayName,
      menu: me === undefined ? [] : accountMenu,
    },
    theme: preferences.theme,
  };
  const status = {
    // No prompt before the session loads. /me carries no login name: the display name stands in.
    context:
      me === undefined
        ? ""
        : statusPrompt(me.account.displayName, currentOrg?.slug ?? null, pathname),
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

  // Until the session and the org's readiness are known, a workspace route shows only the neutral
  // state both layouts share (never the shell first, then the setup layout).
  if (
    setupRoute !== "outside" &&
    error === undefined &&
    (session === undefined || readiness.state.kind === "unknown")
  ) {
    return <PendingState frame="app" />;
  }

  if (session !== undefined && readiness.state.kind === "setup" && setupRoute !== "outside") {
    if (setupRoute === "redirect") return <PendingState frame="app" />;
    const multiOrg = session.me.memberships.length > 1 || session.me.canCreateOrg;
    const setupStatus = {
      ...status,
      context: statusPrompt(
        session.me.account.displayName,
        currentOrg?.slug ?? null,
        setupRoute === "home" ? "/setup" : pathname,
      ),
    };
    const setupFrame = {
      org: currentOrg
        ? {
            name: currentOrg.name,
            slug: currentOrg.slug,
            role: roles[currentOrg.role] ?? currentOrg.role,
            menu: multiOrg ? orgItems : [],
          }
        : null,
      account: {
        name: session.me.account.displayName,
        // Language ▸, personal settings, sign out: the org has its own menu in the top bar.
        menu: accountMenu.filter((i) => !orgMenu.includes(i)),
      },
      theme: preferences.theme,
      status: setupStatus,
    };
    const { agents, providers } = readiness.state;
    return (
      <SessionContext.Provider value={session}>
        <SetupContext.Provider value={{ active: true, recheck: readiness.recheck }}>
          {setupRoute === "home" ? (
            <SetupPage
              {...setupFrame}
              header={{
                path: [{ label: currentOrg?.slug ?? "~" }, { label: t("chat.setup.title") }],
                title: t("chat.setup.title"),
                description: t("chat.setup.description"),
              }}
            >
              <SetupHome
                me={session.me}
                agents={agents}
                providers={providers}
                onRefresh={() => void readiness.recheck()}
              />
            </SetupPage>
          ) : (
            <SetupPage
              {...setupFrame}
              width="content"
              back={{ label: t("setupLayout.back"), href: "/" }}
            >
              {children}
            </SetupPage>
          )}
          {session.me.canCreateOrg ? (
            <CreateOrgDialog open={creatingOrg} onOpenChange={setCreatingOrg} />
          ) : null}
        </SetupContext.Provider>
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
