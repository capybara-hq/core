import { CATALOG_ITEM_NAME_RE, THEME_AVATAR_ID_RE } from "@capybara-hq/plugin-sdk";

/** A pattern's source without its `^` / `$` anchors. */
const body = (re: RegExp) => re.source.replace(/^\^/, "").replace(/\$$/, "");

/**
 * A theme avatar preset's key (theme brand coverage spec §4): `<plugin>/<theme file id>/<preset
 * id>`, the plugin and theme ids as catalog item names, the preset id as {@link THEME_AVATAR_ID_RE}.
 * A leaf module (SDK only): the themes and the agents both read it.
 */
export const THEME_PRESET_KEY_RE = new RegExp(
  `^${body(CATALOG_ITEM_NAME_RE)}/${body(CATALOG_ITEM_NAME_RE)}/${body(THEME_AVATAR_ID_RE)}$`,
);
