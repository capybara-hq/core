"use client";

import type { CommandGroup, MenuItem, TopBarProps } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "../../i18n/navigation";
import { listInbox } from "../../lib/inbox";
import { listUiContributions, type UiContributionItem, uiLocale } from "../../lib/ui";

/**
 * 导航项的可见范围：`all` 所有人，`member` 成员以上（访客看不到），`admin` 管理员以上；
 * `enterprise` 只给企业管理员（`me.account.isEnterpriseAdmin`，与组织角色无关）。
 */
type NavAudience = "all" | "member" | "admin" | "enterprise";
/** 当前用户在当前组织里能看到哪一档导航项。 */
export type NavLevel = "guest" | "member" | "admin";

/**
 * 一级导航：只列已存在的路由（spec §4.1 的其余项上线后再加）。按 `audience` 对当前组织的角色隐藏
 * （只是界面上的隐藏，最终由内核判定权限）。技能库与 agent 并列：成员可浏览，访客不可。
 */
const NAV: readonly { id: string; key: string; href: string; audience: NavAudience }[] = [
  { id: "overview", key: "overview", href: "/", audience: "all" },
  { id: "agents", key: "agents", href: "/agents", audience: "all" },
  { id: "skills", key: "skills", href: "/skills", audience: "member" },
  { id: "inbox", key: "inbox", href: "/inbox", audience: "all" },
  { id: "connectors", key: "connectors", href: "/connectors", audience: "all" },
  // The catalog (org view): members browse and request, org admins install
  { id: "catalog", key: "catalog", href: "/catalog", audience: "member" },
  { id: "channels", key: "channels", href: "/channels", audience: "admin" },
  // 评测：评测集与运行（评测页有「运行记录」入口）；agent 负责人从 agent 详情页进入运行记录
  { id: "evals", key: "evals", href: "/evals", audience: "admin" },
  // 管理后台（部署设置与全部组织 / 账号）：企业管理员
  { id: "admin", key: "admin", href: "/admin", audience: "enterprise" },
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

/** 归在「连接器」下的设置页，与设置页的二级导航一致。 */
const CONNECTOR_SETTINGS = [
  "/settings/connections",
  "/settings/grants",
  "/settings/identities",
  "/settings/organization",
  "/settings/extensions",
  "/settings/plugins",
  "/settings/models",
];

const under = (pathname: string, prefix: string) =>
  pathname === prefix || pathname.startsWith(`${prefix}/`);

/** 当前路由属于哪个一级导航项（对话页归在 Agents 下，个人连接 / 授权页归在连接器下，运行记录归在评测下）。 */
export function activeNavOf(pathname: string): string {
  if (under(pathname, "/agents") || under(pathname, "/chat")) return "agents";
  if (under(pathname, "/skills")) return "skills";
  if (under(pathname, "/inbox")) return "inbox";
  if (under(pathname, "/channels")) return "channels";
  if (under(pathname, "/evals") || under(pathname, "/trajectories")) return "evals";
  if (under(pathname, "/admin")) return "admin";
  if (under(pathname, "/catalog")) return "catalog";
  if (under(pathname, "/connectors") || CONNECTOR_SETTINGS.some((p) => under(pathname, p)))
    return "connectors";
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
 * 顶栏「扩展」菜单的菜单项：当前组织已启用插件的页面贡献（`place: "page"`），按插件分组（组间分隔线），
 * 显示「插件 · 页面标题」。渲染 schema 视图与嵌入应用（`kind: "embed"`）都列，页面按 kind 渲染。
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

/**
 * 顶栏一级导航与命令面板。`enterpriseAdmin`：当前账号是企业管理员时多出「管理」（只是界面上的隐藏，
 * `/api/v1/admin/*` 由内核判定）。
 */
export function useNav(
  pending = 0,
  level: NavLevel = "guest",
  pendingMore = false,
  enterpriseAdmin = false,
): Pick<TopBarProps, "nav" | "commands"> {
  const t = useTranslations();
  const router = useRouter();
  const visible = (a: NavAudience) =>
    a === "enterprise" ? enterpriseAdmin : VISIBLE[level].includes(a);
  const nav = NAV.filter((n) => visible(n.audience)).map((n) => ({
    id: n.id,
    label: t(`nav.${n.key}`),
    href: n.href,
    ...(n.id === "inbox" && pending > 0
      ? { count: pending, ...(pendingMore ? { countMore: true } : {}) }
      : {}),
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
        {
          id: "new-app",
          label: t("connectors.new"),
          onSelect: () => router.push("/connectors/install"),
        },
      ],
    },
  ];
  return { nav, commands };
}
