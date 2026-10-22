"use client";

import { useTranslations } from "next-intl";

/** 后台各页的 id 与路由（只列已存在的页面；模型等页上线后再加）。 */
export const ADMIN_PAGES = [
  { id: "overview", href: "/admin" },
  { id: "accounts", href: "/admin/accounts" },
  { id: "orgs", href: "/admin/orgs" },
  { id: "plugins", href: "/admin/plugins" },
  { id: "settings", href: "/admin/settings" },
] as const;

export type AdminPageId = (typeof ADMIN_PAGES)[number]["id"];

/**
 * 管理后台（企业管理员）的二级导航：概览、账号、组织、插件、部署设置。部署设置页（SettingsPage）用作左侧导航，
 * 列表页以页头的上级链接回到概览。组织自己的设置仍在 `/settings/*`。
 */
export function useAdminNav(): { id: AdminPageId; label: string; href: string }[] {
  const t = useTranslations("admin.nav");
  return ADMIN_PAGES.map((p) => ({ id: p.id, label: t(p.id), href: p.href }));
}

/** 列表页页头的上级链接：回到后台概览。 */
export function useAdminParent(): { label: string; href: string } {
  const t = useTranslations("admin");
  return { label: t("title"), href: "/admin" };
}
