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
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter } from "../../i18n/navigation";
import { routing } from "../../i18n/routing";
import { ApiClientError } from "../../lib/api";
import { getMe, logout, type Me, setCurrentOrg } from "../../lib/session";
import { useErrorMessage } from "../../lib/use-error-message";
import { activeNavOf, routeLabel, useNav } from "./nav";
import { type Session, SessionContext } from "./session";

/** 本地时区，如 `UTC+8`、`UTC-3:30`（StatusBar 右侧，spec §4.4）。 */
function timeZoneLabel(): string {
  const offset = -new Date().getTimezoneOffset();
  const sign = offset < 0 ? "-" : "+";
  const h = Math.floor(Math.abs(offset) / 60);
  const m = Math.abs(offset) % 60;
  return `UTC${sign}${h}${m === 0 ? "" : `:${String(m).padStart(2, "0")}`}`;
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
  const { nav, commands } = useNav();
  const [me, setMe] = useState<Me>();
  const [error, setError] = useState<string>();
  const [theme, setTheme] = useState<Theme>("dark");

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
    async (orgId: string) => {
      try {
        await setCurrentOrg(orgId);
        await load();
        // 会话属于原组织：换组织后回到列表
        if (pathname.startsWith("/chat")) router.push("/agents");
      } catch (e) {
        toast.error(errorMessage(e));
      }
    },
    [load, pathname, router, toast, errorMessage],
  );

  const session = useMemo<Session | undefined>(
    () => (me === undefined ? undefined : { me, reload: load, switchOrg }),
    [me, load, switchOrg],
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
      name: me === undefined ? t("common.loading") : `${me.account.displayName} ▾`,
      menu: me === undefined ? [] : userMenu,
    },
    commands,
  };
  const who =
    me === undefined ? "" : `${me.account.displayName}${currentOrg ? `@${currentOrg.name}` : ""}`;
  const status = {
    context: `${who}:${routeLabel(pathname)}`,
    version: `${version} · ${timeZoneLabel()}`,
  };

  let body: ReactNode = null;
  if (session !== undefined) {
    body = <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
  } else if (error !== undefined) {
    body = (
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
    );
  }

  return (
    <AppShell topBar={topBar} status={status}>
      {body}
    </AppShell>
  );
}
