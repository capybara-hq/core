"use client";

import { useLocale, useTranslations } from "next-intl";
import { type UiContributionItem, uiLocale } from "../lib/ui";
import { useOfferedPlatformPages } from "./extension-ui/ClientComponentBlock";
import { usePlatformPages } from "./extension-ui/ExtensionSlot";

/** 后台各页的 id 与路由（只列已存在的页面）。 */
export const ADMIN_PAGES = [
  { id: "overview", href: "/admin" },
  { id: "inbox", href: "/admin/inbox" },
  { id: "accounts", href: "/admin/accounts" },
  { id: "orgs", href: "/admin/orgs" },
  { id: "plugins", href: "/admin/plugins" },
  { id: "extensions", href: "/admin/extensions" },
  { id: "skills", href: "/admin/skills" },
  { id: "agents", href: "/admin/agents" },
  { id: "connectors", href: "/admin/connectors" },
  { id: "themes", href: "/admin/themes" },
  { id: "models", href: "/admin/models" },
  { id: "settings", href: "/admin/settings" },
] as const;

/** The admin console route of a platform page (`platform.page`): `/admin/p/<plugin>/<id>`. */
export const adminPageHref = (plugin: string, id: string) =>
  `/admin/p/${encodeURIComponent(plugin)}/${encodeURIComponent(id)}`;

/** An extension page of the admin console (slot `platform.page`), as a nav item. */
export type AdminExtensionPage = { id: string; label: string; href: string };

/** The nav items of `pages`, labelled by title (with the plugin name when two share a title). */
export function adminExtensionItems(
  pages: readonly UiContributionItem[],
  locale: string,
): AdminExtensionPage[] {
  const lang = uiLocale(locale);
  const titles = pages.map((p) => p.title[lang]);
  return pages.map((p) => {
    const title = p.title[lang];
    const shared = titles.filter((x) => x === title).length > 1;
    return {
      id: `${p.plugin}/${p.id}`,
      label: shared ? `${title} · ${p.plugin}` : title,
      href: adminPageHref(p.plugin, p.id),
    };
  });
}

/**
 * The admin console's extension pages (the extensions' `platform.page` contributions, read while
 * `enabled`; a client component's page only while its code may run); empty while loading, without
 * pages or on a failed read.
 */
export function useAdminExtensionPages(enabled = true): AdminExtensionPage[] {
  const locale = useLocale();
  const { items } = usePlatformPages(enabled);
  return adminExtensionItems(useOfferedPlatformPages(items), locale);
}

export type AdminPageId = (typeof ADMIN_PAGES)[number]["id"];

/**
 * The admin console's (super admins) navigation: overview, the inbox, accounts, orgs, plugins (its
 * tabs hold the marketplaces and the pending confirmations), extensions, the platform skills,
 * agents and connectors (each with a 模板 tab), and themes, models, deployment settings, then a 扩展 group
 * of the extensions' platform pages (hidden when there are none). It feeds the sidebar's admin
 * context only; admin pages carry no inner navigation. An org's own settings stay under
 * `/settings/*`.
 */
export function useAdminNav(): {
  group: string;
  items: { id: string; label: string; href: string }[];
}[] {
  const t = useTranslations("admin.nav");
  const pages = useAdminExtensionPages();
  return [
    {
      group: t("group"),
      items: ADMIN_PAGES.map((p) => ({ id: p.id, label: t(p.id), href: p.href })),
    },
    ...(pages.length === 0 ? [] : [{ group: t("extensionPages"), items: pages }]),
  ];
}
