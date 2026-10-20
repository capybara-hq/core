"use client";

import type { CommandGroup, MenuItem, TopBarProps } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "../../i18n/navigation";
import { listApprovals } from "../../lib/approvals";
import { listUiContributions, type UiContributionItem, uiLocale } from "../../lib/ui";

/**
 * 一级导航：只列已存在的路由（spec §4.1 的其余项上线后再加）。`admin` 项只对当前组织的管理员显示
 * （只是界面上的隐藏，最终由内核判定权限）。
 */
const NAV = [
  { id: "overview", key: "overview", href: "/", admin: false },
  { id: "agents", key: "agents", href: "/agents", admin: false },
  { id: "inbox", key: "inbox", href: "/inbox", admin: false },
  { id: "apps", key: "apps", href: "/apps", admin: false },
  { id: "channels", key: "channels", href: "/channels", admin: true },
] as const;

/** 待处理审批数的刷新间隔（浏览器内轮询，不涉及服务端状态）。 */
const PENDING_POLL_MS = 30_000;

/** 归在「应用」下的设置页，与设置页的二级导航一致。 */
const APP_SETTINGS = [
  "/settings/connections",
  "/settings/grants",
  "/settings/identities",
  "/settings/organization",
  "/settings/plugins",
];

const under = (pathname: string, prefix: string) =>
  pathname === prefix || pathname.startsWith(`${prefix}/`);

/** 当前路由属于哪个一级导航项（对话页归在 Agents 下，个人连接 / 授权页归在应用下）。 */
export function activeNavOf(pathname: string): string {
  if (under(pathname, "/agents") || under(pathname, "/chat")) return "agents";
  if (under(pathname, "/inbox")) return "inbox";
  if (under(pathname, "/channels")) return "channels";
  if (under(pathname, "/apps") || APP_SETTINGS.some((p) => under(pathname, p))) return "apps";
  return pathname === "/" ? "overview" : "";
}

/**
 * 当前用户待处理的审批数（`GET /approvals?status=pending`）：组织或路由变化时、每 30 秒、以及调用
 * `refresh()` 时重读；没有当前组织或读取失败时为 0。
 */
export function usePendingApprovals(
  orgId: string | null,
  pathname: string,
): { count: number; refresh(): void } {
  const [count, setCount] = useState(0);
  const [nonce, setNonce] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname 与 nonce 只用于触发重读
  useEffect(() => {
    if (orgId === null) {
      setCount(0);
      return;
    }
    let disposed = false;
    const load = () =>
      listApprovals(orgId, "pending").then(
        (r) => {
          if (!disposed) setCount(r.approvals.length);
        },
        () => {
          if (!disposed) setCount(0);
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
  return { count, refresh };
}

/** 插件页面的路由：`/p/<插件>/<贡献 id>`。 */
export const pluginPageHref = (plugin: string, id: string) =>
  `/p/${encodeURIComponent(plugin)}/${encodeURIComponent(id)}`;

/**
 * 顶栏「扩展」菜单的菜单项：当前组织已启用插件的页面贡献（`place: "page"`），按插件分组（组间分隔线），
 * 显示「插件 · 页面标题」。嵌入应用（`kind: "embed"`）由 T26 接入，这里先不列。
 * 没有当前组织、没有页面贡献或读取失败时为空（菜单不出现）。
 */
export function useExtensions(orgId: string | null, locale: string): MenuItem[] {
  const [pages, setPages] = useState<UiContributionItem[]>([]);
  useEffect(() => {
    if (orgId === null) {
      setPages([]);
      return;
    }
    let disposed = false;
    listUiContributions(orgId).then(
      ({ items }) => {
        if (!disposed) setPages(items.filter((c) => c.place === "page" && c.kind === "view"));
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
  const plugins = [...new Set(pages.map((p) => p.plugin))];
  return plugins.flatMap((plugin, i): MenuItem[] => [
    ...(i > 0 ? ["separator" as const] : []),
    ...pages
      .filter((p) => p.plugin === plugin)
      .map((p) => ({ label: `${plugin} · ${p.title[lang]}`, href: pluginPageHref(plugin, p.id) })),
  ]);
}

/** StatusBar 上下文路径里的路由段：去掉开头的 `/`，首页记为 `~`。 */
export function routeLabel(pathname: string): string {
  const p = pathname.replace(/^\/+/, "");
  return p === "" ? "~" : p;
}

export function useNav(pending = 0, admin = false): Pick<TopBarProps, "nav" | "commands"> {
  const t = useTranslations();
  const router = useRouter();
  const nav = NAV.filter((n) => admin || !n.admin).map((n) => ({
    id: n.id,
    label: t(`nav.${n.key}`),
    href: n.href,
    ...(n.id === "inbox" && pending > 0 ? { count: pending } : {}),
  }));
  const commands: CommandGroup[] = [
    {
      label: t("nav.goto"),
      items: nav.map((n) => ({
        id: `goto-${n.id}`,
        label: n.label,
        onSelect: () => router.push(n.href),
      })),
    },
    {
      label: t("nav.actions"),
      items: [
        { id: "new-agent", label: t("agents.new"), onSelect: () => router.push("/agents/new") },
        { id: "new-app", label: t("apps.new"), onSelect: () => router.push("/apps/install") },
      ],
    },
  ];
  return { nav, commands };
}
