"use client";

import { useTranslations } from "next-intl";

/** 后台各页的 id 与路由（只列已存在的页面）。 */
export const ADMIN_PAGES = [
  { id: "overview", href: "/admin" },
  { id: "accounts", href: "/admin/accounts" },
  { id: "orgs", href: "/admin/orgs" },
  { id: "extensions", href: "/admin/extensions" },
  { id: "catalog", href: "/admin/catalog" },
  { id: "marketplaces", href: "/admin/marketplaces" },
  { id: "models", href: "/admin/models" },
  { id: "settings", href: "/admin/settings" },
] as const;

export type AdminPageId = (typeof ADMIN_PAGES)[number]["id"];

/**
 * The admin console's (enterprise admins) navigation: overview, accounts, orgs, extensions,
 * catalog, marketplaces, models, deployment settings (the sidebar's admin context). Settings pages (SettingsPage) use it as the left
 * navigation; list pages go back to the overview through the header's path. An org's own
 * settings stay under `/settings/*`.
 */
export function useAdminNav(): {
  group: string;
  items: { id: AdminPageId; label: string; href: string }[];
}[] {
  const t = useTranslations("admin.nav");
  // One group until Task 10 removes the inner nav of the admin pages.
  return [
    {
      group: t("group"),
      items: ADMIN_PAGES.map((p) => ({ id: p.id, label: t(p.id), href: p.href })),
    },
  ];
}
