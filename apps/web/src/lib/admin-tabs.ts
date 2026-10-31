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

/** The two views of the admin "Marketplaces" page head: browse entries, manage sources. */
export function marketplaceTabs(t: (key: MarketKey) => string) {
  return [
    { id: "browse", label: t("tabs.browse"), href: "/admin/marketplaces/entries" },
    { id: "sources", label: t("tabs.sources"), href: "/admin/marketplaces" },
  ];
}
