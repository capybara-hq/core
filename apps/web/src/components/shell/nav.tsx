"use client";

import type { CommandGroup, TopBarProps } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { useRouter } from "../../i18n/navigation";
import { listApprovals } from "../../lib/approvals";

/** 一级导航：只列已存在的路由（spec §4.1 的其余项上线后再加）。 */
const NAV = [
  { id: "overview", key: "overview", href: "/" },
  { id: "agents", key: "agents", href: "/agents" },
  { id: "inbox", key: "inbox", href: "/inbox" },
  { id: "apps", key: "apps", href: "/apps" },
] as const;

/** 待处理审批数的刷新间隔（浏览器内轮询，不涉及服务端状态）。 */
const PENDING_POLL_MS = 30_000;

/** 当前路由属于哪个一级导航项（对话页归在 Agents 下，个人连接页归在应用下）。 */
export function activeNavOf(pathname: string): string {
  if (pathname.startsWith("/agents") || pathname.startsWith("/chat")) return "agents";
  if (pathname.startsWith("/inbox")) return "inbox";
  if (pathname.startsWith("/apps") || pathname.startsWith("/settings")) return "apps";
  return pathname === "/" ? "overview" : "";
}

/**
 * 当前用户待处理的审批数（`GET /approvals?status=pending`）：组织或路由变化时、以及每 30 秒重读；
 * 没有当前组织或读取失败时为 0。
 */
export function usePendingApprovals(orgId: string | null, pathname: string): number {
  const [count, setCount] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname 只用于触发重读（处理审批后回到别的页面）
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
  }, [orgId, pathname]);
  return count;
}

/** StatusBar 上下文路径里的路由段：去掉开头的 `/`，首页记为 `~`。 */
export function routeLabel(pathname: string): string {
  const p = pathname.replace(/^\/+/, "");
  return p === "" ? "~" : p;
}

export function useNav(pending = 0): Pick<TopBarProps, "nav" | "commands"> {
  const t = useTranslations();
  const router = useRouter();
  const nav = NAV.map((n) => ({
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
        { id: "new-app", label: t("apps.new"), onSelect: () => router.push("/apps/new") },
      ],
    },
  ];
  return { nav, commands };
}
