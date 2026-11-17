/**
 * The `plugin_installs.status` values of a live install: the plugin is on in the org (or about to
 * be). `failed` and `uninstalling` are not live. Every query that asks "is this plugin installed
 * in the org" uses this one set.
 */
export const LIVE_INSTALL_STATUSES = ["installing", "installed"] as const;
