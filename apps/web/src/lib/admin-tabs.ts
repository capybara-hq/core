import type { Marketplace } from "./catalog";

type CatalogKey = "tabs.plugins" | "tabs.requests";
type MarketKey = "tabs.browse" | "tabs.sources";

/** The two views of the admin "Catalog" page head: the tab row links the two routes. */
export function catalogTabs(
  t: (key: CatalogKey) => string,
  counts: { plugins?: number; requests?: number } = {},
) {
  return [
    {
      id: "plugins",
      label: t("tabs.plugins"),
      href: "/admin/catalog",
      ...(counts.plugins !== undefined ? { count: counts.plugins } : {}),
    },
    {
      id: "requests",
      label: t("tabs.requests"),
      href: "/admin/catalog/requests",
      ...(counts.requests !== undefined ? { count: counts.requests } : {}),
    },
  ];
}

/**
 * The two views of the admin "Marketplaces" page head: browse entries, manage sources. Both pages
 * pass the marketplaces, so both draw the same counts: the entries of the marketplaces the browse
 * list reads (enabled, not turned off by the deployment config) and the number of marketplaces.
 * Without them (the list failed to load) the tabs carry no counts.
 */
export function marketplaceTabs(
  t: (key: MarketKey) => string,
  sources?: Pick<Marketplace, "enabled" | "disabledByConfig" | "entryCount">[],
) {
  const entries = sources
    ?.filter((s) => s.enabled && !s.disabledByConfig)
    .reduce((n, s) => n + s.entryCount, 0);
  return [
    {
      id: "browse",
      label: t("tabs.browse"),
      href: "/admin/marketplaces/entries",
      ...(entries !== undefined ? { count: entries } : {}),
    },
    {
      id: "sources",
      label: t("tabs.sources"),
      href: "/admin/marketplaces",
      ...(sources !== undefined ? { count: sources.length } : {}),
    },
  ];
}
