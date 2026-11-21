import { sql } from "kysely";
import { importPlugin, type OrgEnv } from "../catalog/org-env.js";
import { pluginTgz } from "../helpers/plugin-packages.js";

/**
 * Theme fixtures for the resolution and settings tests (themes spec §7, §9): one plugin per theme
 * (distinct theme ids, so no rule 10 clash), imported by the super admin.
 */

const DARK = {
  color: { bg: "#05070D", panel: "#0A0E18", accent: "#FCE300", "on-accent": "#141200" },
};
const LOGO =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';

/** Theme `themeId` of plugin `plugin`: `dark` (the Neon Grid colors, a logo) or `both` schemes. */
export const themePlugin = (plugin: string, themeId: string, shape: "dark" | "both" = "dark") =>
  pluginTgz({
    manifest: { name: plugin },
    files: {
      [`themes/${themeId}.json`]: JSON.stringify({
        name: { en: `${themeId} en`, zh: `${themeId} zh` },
        schemes:
          shape === "dark"
            ? { dark: DARK }
            : { dark: { radius: { sm: 2 } }, light: { radius: { md: 4 } } },
        ...(shape === "dark" && { logo: { mark: "./brand/logo.svg", wordmark: "NEON GRID" } }),
      }),
      ...(shape === "dark" && { "brand/logo.svg": LOGO }),
    },
  });

/** Imports a one-theme plugin; returns the theme's `platform_themes` id and the item id. */
export async function importTheme(
  env: OrgEnv,
  plugin: string,
  themeId: string,
  shape: "dark" | "both" = "dark",
): Promise<{ id: string; itemId: string }> {
  const itemId = await importPlugin(env, await themePlugin(plugin, themeId, shape));
  const t = await env.db
    .selectFrom("platform_themes")
    .select("id")
    .where("catalog_item_id", "=", itemId)
    .executeTakeFirstOrThrow();
  return { id: t.id, itemId };
}

/** Gives a theme its own scope directly in the database (no preview / guard). */
export const setThemeScope = (env: OrgEnv, id: string, scope: "all" | "optional" | "named") =>
  env.db
    .updateTable("platform_themes")
    .set({ scope_mode: "own", scope })
    .where("id", "=", id)
    .execute();

/** Sets the org's switch of a theme directly in the database. */
export const setThemeSwitch = (env: OrgEnv, orgId: string, id: string, enabled: boolean) =>
  env.db
    .insertInto("component_org_switches")
    .values({ kind: "theme", component_id: id, org_id: orgId, enabled })
    .onConflict((oc) => oc.columns(["kind", "component_id", "org_id"]).doUpdateSet({ enabled }))
    .execute();

/** Writes the `uiTheme` row directly (no eligibility check). */
export const writeUiTheme = (env: OrgEnv, id: string | null) =>
  env.db
    .insertInto("deployment_settings")
    .values({ key: "uiTheme", value: JSON.stringify({ id }) })
    .onConflict((oc) => oc.column("key").doUpdateSet({ value: JSON.stringify({ id }) }))
    .execute();

/** Writes an org's `theme` setting directly (no availability check). */
export const writeOrgTheme = (
  env: OrgEnv,
  orgId: string,
  theme: { id: string | null; personal: "allowed" | "locked" },
) =>
  env.db
    .updateTable("orgs")
    .set({
      settings:
        sql`settings || jsonb_build_object('theme', ${JSON.stringify(theme)}::jsonb)` as unknown as string,
    })
    .where("id", "=", orgId)
    .execute();

/** Clears every theme level: people's picks and orgs' settings (the catalog reset clears the rest). */
export async function clearThemeLevels(env: OrgEnv): Promise<void> {
  await env.db.updateTable("accounts").set({ theme: null, time_zone: null }).execute();
  await env.db
    .updateTable("orgs")
    .set({ settings: sql`settings - 'theme'` as unknown as string })
    .execute();
}

/**
 * Theme `themeId` of plugin `plugin` with agent avatar presets (theme brand coverage spec §4):
 * `presets` are preset ids, each with its file `./avatars/<id>.svg`; `hidden` the built-ins it
 * hides. `fill` changes the SVG bytes (a new theme version on update).
 */
export const avatarThemePlugin = (
  plugin: string,
  themeId: string,
  o: { presets?: string[]; hidden?: string[]; version?: string; fill?: string } = {},
) => {
  const presets = o.presets ?? ["mascot"];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="${o.fill ?? "#000"}"/></svg>`;
  return pluginTgz({
    manifest: { name: plugin, ...(o.version !== undefined && { version: o.version }) },
    files: {
      [`themes/${themeId}.json`]: JSON.stringify({
        name: { en: `${themeId} en`, zh: `${themeId} zh` },
        schemes: { dark: { radius: { sm: 2 } } },
        avatars: presets.map((id) => ({
          id,
          name: { en: `${id} en`, zh: `${id} zh` },
          file: `./avatars/${id}.svg`,
        })),
        ...(o.hidden !== undefined && { hideAvatarPresets: o.hidden }),
      }),
      ...Object.fromEntries(presets.map((id) => [`avatars/${id}.svg`, svg])),
    },
  });
};

/**
 * Imports {@link avatarThemePlugin} as the super admin, gives the theme its own scope `all` and
 * returns its `platform_themes` id and the item id.
 */
export async function importAvatarTheme(
  env: OrgEnv,
  plugin: string,
  themeId: string,
  o: { presets?: string[]; hidden?: string[] } = {},
): Promise<{ id: string; itemId: string }> {
  const itemId = await importPlugin(env, await avatarThemePlugin(plugin, themeId, o));
  const t = await env.db
    .selectFrom("platform_themes")
    .select("id")
    .where("catalog_item_id", "=", itemId)
    .executeTakeFirstOrThrow();
  await setThemeScope(env, t.id, "all");
  return { id: t.id, itemId };
}
