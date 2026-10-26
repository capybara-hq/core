"use client";

import {
  AppShell,
  applyTheme,
  Button,
  type MenuItem,
  parseTheme,
  StatusPage,
  type Theme,
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
import { routing } from "../../i18n/routing";
import { ApiClientError } from "../../lib/api";
import { loginPathFor } from "../../lib/auth-sources";
import { useConnectResultToast } from "../../lib/connect";
import { getMe, logout, type Me, setCurrentOrg } from "../../lib/session";
import { useErrorMessage } from "../../lib/use-error-message";
import { useConversationGroups } from "./conversations";
import {
  activeNavOf,
  navLevelOf,
  routeLabel,
  useExtensions,
  useNav,
  usePendingApprovals,
} from "./nav";
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
  const [error, setError] = useState<string>();
  const [theme, setTheme] = useState<Theme>("dark");
  const timeZone = useTimeZoneLabel();
  useConnectResultToast();

  useEffect(() => {
    setTheme(parseTheme(document.documentElement.dataset.theme));
  }, []);

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
        : { me, reload: load, switchOrg, refreshPending: pending.refresh },
    [me, load, switchOrg, pending.refresh],
  );

  async function onLogout() {
    try {
      await logout();
    } finally {
      router.replace("/login");
    }
  }

  const nextTheme: Theme = theme === "dark" ? "light" : "dark";
  const userMenu: MenuItem[] = [
    ...routing.locales
      .filter((l) => l !== locale)
      .map((l) => ({
        label: t("shell.switchLocale", { name: t(`common.localeName.${l}`) }),
        onSelect: () => router.replace(pathname, { locale: l }),
      })),
    {
      label: nextTheme === "light" ? t("shell.themeLight") : t("shell.themeDark"),
      onSelect: () => {
        applyTheme(nextTheme);
        setTheme(nextTheme);
      },
    },
    "separator",
    { label: t("common.logout"), onSelect: () => void onLogout() },
  ];

  const currentOrg = me?.memberships.find((m) => m.orgId === me.currentOrgId);
  // The org switch heads the account menu (the current org checked).
  const orgItems: MenuItem[] =
    me === undefined || me.memberships.length === 0
      ? []
      : [
          ...me.memberships.map((m) => ({
            label: m.name,
            checked: m.orgId === me.currentOrgId,
            disabled: m.orgId === me.currentOrgId,
            onSelect: () => void switchOrg(m.orgId),
          })),
          "separator" as const,
        ];
  const sidebar = {
    // "New conversation" picks an agent first (composer-first creation comes with project B)
    newConversation: { href: "/agents" },
    nav,
    activeNav: activeNavOf(pathname),
    extensions,
    footerNav,
    conversations,
    account: {
      name: me === undefined ? t("common.loading") : me.account.displayName,
      // memberships but no current org: the footer asks to pick one (the old TopBar cue)
      org:
        currentOrg?.name ??
        (me !== undefined && me.memberships.length > 0 ? t("shell.noOrg") : null),
      menu: me === undefined ? [] : [...orgItems, ...userMenu],
    },
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
        header={{ title: t("common.loadFailed") }}
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
      <SessionContext.Provider value={session ?? null}>{children}</SessionContext.Provider>
    );

  return (
    <AppShell sidebar={sidebar} commands={commands} status={status}>
      {body}
    </AppShell>
  );
}
