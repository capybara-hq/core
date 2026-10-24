"use client";

import { useTranslations } from "next-intl";

/** 后台各页的 id 与路由（只列已存在的页面）。 */
export const ADMIN_PAGES = [
  { id: "overview", href: "/admin" },
  { id: "accounts", href: "/admin/accounts" },
  { id: "orgs", href: "/admin/orgs" },
  { id: "extensions", href: "/admin/extensions" },
  { id: "catalog", href: "/admin/catalog" },
  { id: "models", href: "/admin/models" },
  { id: "settings", href: "/admin/settings" },
] as const;

export type AdminPageId = (typeof ADMIN_PAGES)[number]["id"];

/**
 * The admin console's (enterprise admins) second-level navigation: overview, accounts, orgs,
 * extensions, catalog, models, deployment settings. Settings pages (SettingsPage) use it as the left
 * navigation; list pages go back to the overview through the header's parent link. An org's own
 * settings stay under `/settings/*`.
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
