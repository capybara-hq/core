"use client";

import type { CommandGroup, TopBarProps } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useRouter } from "../../i18n/navigation";

/** 一级导航：只列已存在的路由（spec §4.1 的其余项上线后再加）。 */
const NAV = [
  { id: "overview", key: "overview", href: "/" },
  { id: "agents", key: "agents", href: "/agents" },
] as const;

/** 当前路由属于哪个一级导航项（对话页归在 Agents 下）。 */
export function activeNavOf(pathname: string): string {
  if (pathname.startsWith("/agents") || pathname.startsWith("/chat")) return "agents";
  return pathname === "/" ? "overview" : "";
}

/** StatusBar 上下文路径里的路由段：去掉开头的 `/`，首页记为 `~`。 */
export function routeLabel(pathname: string): string {
  const p = pathname.replace(/^\/+/, "");
  return p === "" ? "~" : p;
}

export function useNav(): Pick<TopBarProps, "nav" | "commands"> {
  const t = useTranslations();
  const router = useRouter();
  const nav = NAV.map((n) => ({ id: n.id, label: t(`nav.${n.key}`), href: n.href }));
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
      ],
    },
  ];
  return { nav, commands };
}
