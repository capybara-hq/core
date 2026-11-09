import { sql } from "kysely";
import { importClientPlugin, sha384 } from "../client/client-env.js";
import { pluginTgz } from "../helpers/plugin-packages.js";
import type { OrgEnv } from "./org-env.js";

/**
 * Shared setup of the suggested appearance tests (client extensions spec §6.5): `cx-look`, a plugin
 * with client code (components `brand` in `shell.brand` and `empty` in `conversation.empty`), a
 * theme `look` and a `suggestedAppearance` naming the theme, both components and a slot the SDK does
 * not know (`shell.future`).
 */

export const LOOK = "cx-look";

const enc = (s: string) => new TextEncoder().encode(s);

const THEME = JSON.stringify({
  name: { en: "Look", zh: "外观" },
  schemes: {
    dark: {
      color: { bg: "#05070D", panel: "#0A0E18", accent: "#FCE300", "on-accent": "#141200" },
    },
  },
});

/** The `cx-look` package. */
export async function lookPlugin(): Promise<Uint8Array> {
  const js = enc('export default { name: "cx-look" };\n');
  const components = [
    { id: "brand", slot: "shell.brand" },
    { id: "empty", slot: "conversation.empty" },
  ];
  const ui = components.map((c) => ({
    id: c.id,
    title: { zh: c.id, en: c.id },
    slot: c.slot,
    kind: "component",
  }));
  const permissions = { client: true, ui: { components: components.map((c) => c.id) } };
  const base = { name: LOOK, version: "1.0.0", sdk: "^0.1.0-rc.0", provides: [], permissions, ui };
  return pluginTgz({
    manifest: {
      name: LOOK,
      suggestedAppearance: {
        theme: "look",
        replacements: {
          "shell.brand": "brand",
          "conversation.empty": "empty",
          "shell.future": "fx",
        },
      },
    },
    files: { "dist/client/client.mjs": js, "themes/look.json": THEME },
    extension: {
      manifest: { permissions, ui },
      section: {
        client: {
          entry: "./dist/client/client.mjs",
          integrity: { "./dist/client/client.mjs": sha384(js) },
          apiVersion: 1,
        },
      },
      entry: [
        'import { defineExtension } from "@capybara-hq/plugin-sdk";',
        `export default defineExtension({ ...${JSON.stringify(base)}, setup() {} });`,
      ].join("\n"),
    },
  });
}

/** Imports `cx-look`; returns its item id and its theme's `platform_themes` id. */
export async function importLook(env: OrgEnv): Promise<{ itemId: string; themeId: string }> {
  const itemId = await importClientPlugin(env, await lookPlugin(), LOOK);
  const t = await env.db
    .selectFrom("platform_themes")
    .select("id")
    .where("catalog_item_id", "=", itemId)
    .executeTakeFirstOrThrow();
  return { itemId, themeId: t.id };
}

/** Clears both levels the action writes: the platform theme and arrangement, every org's copy. */
export async function clearAppearance(env: OrgEnv): Promise<void> {
  await env.db
    .deleteFrom("deployment_settings")
    .where("key", "in", ["uiTheme", "uiArrangement"])
    .execute();
  await env.db
    .updateTable("orgs")
    .set({ settings: sql`settings - 'theme' - 'uiArrangement'` as unknown as string })
    .execute();
}

/** The stored platform rows of the two settings the action writes (absent: undefined). */
export async function platformRows(env: OrgEnv): Promise<Record<string, unknown>> {
  const rows = await env.db
    .selectFrom("deployment_settings")
    .select(["key", "value"])
    .where("key", "in", ["uiTheme", "uiArrangement"])
    .execute();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

/** The org's stored `theme` and `uiArrangement`. */
export async function orgRows(
  env: OrgEnv,
  orgId: string,
): Promise<{ theme?: unknown; uiArrangement?: unknown }> {
  const row = await env.db
    .selectFrom("orgs")
    .select("settings")
    .where("id", "=", orgId)
    .executeTakeFirstOrThrow();
  const s = row.settings as Record<string, unknown>;
  return {
    ...(s.theme !== undefined && { theme: s.theme }),
    ...(s.uiArrangement !== undefined && { uiArrangement: s.uiArrangement }),
  };
}
