type PluginTabKey = "tabs.installed" | "tabs.market" | "tabs.pending";

/** The tabs of the admin 插件 page head: 已安装, 市场, 待确认 (each its own route). */
export type PluginTab = "installed" | "market" | "pending";

/**
 * The three views of the admin 插件 page head. `installed` is the number of plugins, `pending` the
 * plugins waiting for a permission confirmation plus the pending requests; without them (still
 * loading, or the read failed) the tabs carry no count.
 */
export function pluginTabs(
  t: (key: PluginTabKey) => string,
  counts: { installed?: number | undefined; pending?: number | undefined } = {},
) {
  return [
    {
      id: "installed",
      label: t("tabs.installed"),
      href: "/admin/plugins",
      ...(counts.installed !== undefined ? { count: counts.installed } : {}),
    },
    { id: "market", label: t("tabs.market"), href: "/admin/plugins/market" },
    {
      id: "pending",
      label: t("tabs.pending"),
      href: "/admin/plugins/pending",
      ...(counts.pending !== undefined ? { count: counts.pending } : {}),
    },
  ];
}
