/**
 * Plugin scope rules (plugin and component management spec §5). Pure functions only: the
 * caller reads the item's scope, disabled and builtin flags, the org's list membership and its
 * explicit switch, and these functions decide the effective state.
 */

/** Who an enterprise plugin is offered to: every org, an opt-in set, or the listed orgs. */
export type PluginScope = "all" | "optional" | "named";

/** The effective state of a plugin in one org. */
export type OrgPluginState = "on" | "off" | "needs_config" | "unavailable";

/**
 * Whether the item should be on in the org. Builtin implies `all`: it is on unless disabled and
 * its switch is ignored. Otherwise `all` is on unless disabled, `optional` is on only with an
 * explicit `true` switch, and `named` is on for a listed org unless its switch is `false`.
 */
export function wantedOn(
  item: { scope: PluginScope; disabled: boolean; builtin: boolean },
  inList: boolean,
  sw: boolean | null,
): boolean {
  if (item.disabled) return false;
  const scope = item.builtin ? "all" : item.scope;
  switch (scope) {
    case "all":
      return true;
    case "optional":
      return sw === true;
    case "named":
      return inList && sw !== false;
  }
}

/** Whether the org may see the item at all: a named item only for the orgs on its list. */
export function visibleTo(item: { scope: PluginScope }, inList: boolean): boolean {
  return item.scope !== "named" || inList;
}

/** Whether the org admin may switch the item: never for `all` or builtin items. */
export function switchable(item: { scope: PluginScope; builtin: boolean }): boolean {
  return !item.builtin && item.scope !== "all";
}
