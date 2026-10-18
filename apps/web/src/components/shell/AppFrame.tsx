"use client";

import {
  AppShell,
  applyTheme,
  Button,
  type MenuItem,
  parseTheme,
  StatusPage,
  type Theme,
  type TopBarProps,
  useToast,
} from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { usePathname, useRouter } from "../../i18n/navigation";
import { routing } from "../../i18n/routing";
import { ApiClientError } from "../../lib/api";
import { useConnectResultToast } from "../../lib/connect";
import { getMe, logout, type Me, setCurrentOrg } from "../../lib/session";
import { useErrorMessage } from "../../lib/use-error-message";
import { activeNavOf, routeLabel, useNav, usePendingApprovals } from "./nav";
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
 * (app) 路由组的外框：读取 `GET /api/v1/me`（401 → 登录页），以 {@link SessionContext} 提供给页面，
 * 并渲染 App Shell——顶栏（一级导航、组织菜单、用户菜单：语言 / 主题 / 退出登录）与状态栏
 * （`> 账号@组织:路由` · 版本 · 时区）。会话就绪前不渲染页面。
 */
export function AppFrame({ version, children }: { version: string; children: ReactNode }) {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const errorMessage = useErrorMessage();
  const toast = useToast();
  const [me, setMe] = useState<Me>();
  const pending = usePendingApprovals(me?.currentOrgId ?? null, pathname);
  const { nav, commands } = useNav(pending.count);
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
      if (e instanceof ApiClientError && e.status === 401) router.replace("/login");
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
        // 应用详情同理：应用属于原组织
        else if (pathname.startsWith("/apps/") && pathname !== "/apps/new") router.push("/apps");
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
  const topBar: TopBarProps = {
    nav,
    activeNav: activeNavOf(pathname),
    org:
      me === undefined || me.memberships.length === 0
        ? null
        : {
            name: currentOrg?.name ?? t("shell.noOrg"),
            menu: me.memberships.map((m) => ({
              label: m.orgId === me.currentOrgId ? `✓ ${m.name}` : m.name,
              disabled: m.orgId === me.currentOrgId,
              onSelect: () => void switchOrg(m.orgId),
            })),
          },
    user: {
      name: me === undefined ? t("common.loading") : me.account.displayName,
      menu: me === undefined ? [] : userMenu,
    },
    commands,
  };
  const who =
    me === undefined ? "" : `${me.account.displayName}${currentOrg ? `@${currentOrg.name}` : ""}`;
  const status = {
    // 会话加载前不显示上下文路径（避免出现 `> :~`）
    context: me === undefined ? "" : `${who}:${routeLabel(pathname)}`,
    version: timeZone === "" ? version : `${version} · ${timeZone}`,
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
    <AppShell topBar={topBar} status={status}>
      {body}
    </AppShell>
  );
}
