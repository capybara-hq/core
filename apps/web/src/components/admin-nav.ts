"use client";

import { useTranslations } from "next-intl";

/** 后台各页的 id 与路由（只列已存在的页面）。 */
export const ADMIN_PAGES = [
  { id: "overview", href: "/admin" },
  { id: "inbox", href: "/admin/inbox" },
  { id: "accounts", href: "/admin/accounts" },
  { id: "orgs", href: "/admin/orgs" },
  { id: "plugins", href: "/admin/plugins" },
  { id: "extensions", href: "/admin/extensions" },
  { id: "skills", href: "/admin/skills" },
  { id: "connector-templates", href: "/admin/connector-templates" },
  { id: "agent-templates", href: "/admin/agent-templates" },
  { id: "models", href: "/admin/models" },
  { id: "settings", href: "/admin/settings" },
] as const;

export type AdminPageId = (typeof ADMIN_PAGES)[number]["id"];

/**
 * The admin console's (super admins) navigation: overview, the inbox, accounts, orgs, plugins (its
 * tabs hold the marketplaces and the pending confirmations), extensions, the platform skills,
 * connector templates and agent templates, models, deployment settings. It feeds the sidebar's admin context only;
 * admin pages carry no inner navigation. An org's own settings stay under `/settings/*`.
 */
export function useAdminNav(): {
  group: string;
  items: { id: AdminPageId; label: string; href: string }[];
}[] {
  const t = useTranslations("admin.nav");
  return [
    {
      group: t("group"),
      items: ADMIN_PAGES.map((p) => ({ id: p.id, label: t(p.id), href: p.href })),
    },
  ];
}
