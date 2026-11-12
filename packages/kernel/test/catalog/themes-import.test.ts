import { createHash } from "node:crypto";
import {
  type ParsedTheme,
  PLUGIN_MANIFEST_FILE,
  SDK_VERSION,
  sanitizeThemeSvg,
} from "@capybara-hq/plugin-sdk";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PluginPackageError, readPluginFiles } from "../../src/catalog/plugin-package.js";
import type { PlatformUpdatePreview } from "../../src/catalog/plugin-upgrade.js";
import { StorageService } from "../../src/storage/storage.service.js";
import { pluginTgz } from "../helpers/plugin-packages.js";
import { SKILL_MD } from "../skills/zip.js";
import {
  importPlugin,
  type OrgEnv,
  resetOrgCatalog,
  setDeployment,
  startOrgEnv,
} from "./org-env.js";

/**
 * Themes spec §5-§6 (plan Task 6): a plugin's themes are read and checked at import (an invalid or
 * unreadable theme refuses the whole plugin), synced as platform components with their sanitized
 * assets under `deployment/platform/themes/sha256-<digest>/` (keyed by content), updated with their
 * plugin and removed with it. An org upload of a themes-only plugin is not gated by the custom
 * content switches.
 */

const enc = (s: string) => new TextEncoder().encode(s);
const FONT = enc("wOF2");
/** A logo with what the sanitizer drops (a comment, width / height). */
const LOGO =
  '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10"><!-- editor --><path d="M0 0h10v10z" fill="#FCE300"/></svg>';

const theme = (over: Record<string, unknown> = {}, dark: Record<string, string> = {}) =>
  JSON.stringify({
    name: { en: "Neon Grid", zh: "霓虹网格" },
    description: { en: "Neon on black.", zh: "黑底霓虹。" },
    schemes: {
      dark: {
        color: {
          bg: "#05070D",
          panel: "#0A0E18",
          accent: "#FCE300",
          "on-accent": "#141200",
          ...dark,
        },
        radius: { sm: 0, md: 2 },
      },
    },
    fonts: [
      { family: "Fixture", file: "./fonts/Fixture-Regular.woff2", weight: 400, role: "prose" },
    ],
    logo: { mark: "./logo.svg", wordmark: "NEON GRID" },
    ...over,
  });

const themePlugin = (
  name: string,
  o: {
    version?: string;
    themeJson?: string;
    font?: Uint8Array;
    extra?: Record<string, string | Uint8Array>;
    noTheme?: boolean;
  } = {},
) =>
  pluginTgz({
    manifest: { name, ...(o.version !== undefined && { version: o.version }) },
    files: {
      ...(o.noTheme !== true && {
        "themes/neon-grid.json": o.themeJson ?? theme(),
        "fonts/Fixture-Regular.woff2": o.font ?? FONT,
        "logo.svg": LOGO,
      }),
      ...o.extra,
    },
  });

describe("readPluginFiles reads themes", () => {
  const files = (entries: Record<string, string | Uint8Array>) =>
    new Map(
      Object.entries({
        [PLUGIN_MANIFEST_FILE]: JSON.stringify({
          schemaVersion: 1,
          name: "t",
          version: "1.0.0",
          publisher: "P",
          description: "d",
        }),
        ...entries,
      }).map(([k, v]) => [k, typeof v === "string" ? enc(v) : v]),
    );
  const read = (entries: Record<string, string | Uint8Array>) =>
    readPluginFiles(files(entries), { hostSdkVersion: SDK_VERSION, requirePackageJson: false });
  const failure = (entries: Record<string, string | Uint8Array>) => {
    try {
      read(entries);
    } catch (e) {
      if (e instanceof PluginPackageError) return e;
      throw e;
    }
    throw new Error("expected a PluginPackageError");
  };

  it("a themes-only plugin carries its parsed theme and sanitized assets", () => {
    const c = read({
      "themes/neon-grid.json": theme(),
      "fonts/Fixture-Regular.woff2": FONT,
      "logo.svg": LOGO,
    });
    expect(c.themes).toHaveLength(1);
    const t = c.themes[0];
    expect(t?.id).toBe("neon-grid");
    expect(t?.path).toBe("themes/neon-grid.json");
    expect(t?.theme.schemes.dark?.color?.accent).toBe("#FCE300");
    expect([...(t?.assets.keys() ?? [])].sort()).toEqual([
      "fonts/Fixture-Regular.woff2",
      "logo.svg",
    ]);
    const logo = new TextDecoder().decode(t?.assets.get("logo.svg"));
    expect(logo).not.toContain("editor");
    expect(logo).toBe((sanitizeThemeSvg(enc(LOGO)) as { svg: string }).svg);
  });

  it("the carries-nothing message counts themes", () => {
    const e = failure({});
    expect(e.code).toBe("catalog.invalid_manifest");
    expect(e.issues.join("\n")).toContain("or a theme");
  });

  it("an invalid theme is theme.invalid naming the theme", () => {
    const e = failure({
      "themes/neon-grid.json": theme({}, { "no-such-token": "#000000" }),
      "fonts/Fixture-Regular.woff2": FONT,
      "logo.svg": LOGO,
    });
    expect(e.code).toBe("theme.invalid");
    expect(e.themes).toEqual([
      { theme: "neon-grid", problems: [expect.stringContaining("no-such-token")] },
    ]);
  });

  it("a missing asset is theme.invalid", () => {
    const e = failure({ "themes/neon-grid.json": theme(), "logo.svg": LOGO });
    expect(e.code).toBe("theme.invalid");
    expect(e.themes?.[0]?.problems.join("\n")).toContain("Fixture-Regular.woff2");
  });

  it("an unreadable theme is theme.unreadable listing the failing pairs", () => {
    const e = failure({
      "themes/neon-grid.json": theme({}, { bg: "#8E8E89" }),
      "fonts/Fixture-Regular.woff2": FONT,
      "logo.svg": LOGO,
    });
    expect(e.code).toBe("theme.unreadable");
    expect(e.themes?.[0]?.theme).toBe("neon-grid");
    expect(e.themes?.[0]?.problems.some((p) => p.includes("muted on bg"))).toBe(true);
  });

  it("the 16 MB asset limit covers all of a plugin's themes", () => {
    const entries: Record<string, string | Uint8Array> = {};
    for (const id of ["one", "two"]) {
      const fonts = [];
      for (let i = 0; i < 6; i++) {
        const file = `fonts/${id}${i}.woff2`;
        const bytes = new Uint8Array(1_500_000);
        bytes.set(FONT);
        entries[file] = bytes;
        fonts.push({ family: `F${id}${i}`, file: `./${file}`, weight: 400, role: "prose" });
      }
      entries[`themes/${id}.json`] = theme({ fonts, logo: undefined });
    }
    const e = failure(entries);
    expect(e.code).toBe("theme.invalid");
    expect(e.issues.join("\n")).toContain("16777216");
  });
});

describe("themes as platform components", () => {
  let env: OrgEnv;

  beforeAll(async () => {
    env = await startOrgEnv();
  }, 240_000);

  afterAll(async () => {
    await env?.stop();
  });

  beforeEach(async () => {
    await resetOrgCatalog(env);
  });

  const prepare = (bytes: Uint8Array) =>
    env.root({
      method: "POST",
      url: "/api/v1/admin/catalog/import/file",
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from(bytes),
    });

  const themeRow = (name = "neon-grid") =>
    env.db
      .selectFrom("platform_themes")
      .selectAll()
      .where("name", "=", name)
      .executeTakeFirstOrThrow();

  const versionRow = (themeId: string, version: number) =>
    env.db
      .selectFrom("platform_theme_versions")
      .selectAll()
      .where("theme_id", "=", themeId)
      .where("version", "=", version)
      .executeTakeFirstOrThrow();

  const stored = async (key: string) => {
    const got = await env.k.app.get(StorageService).deployment().get(key);
    return got ? new Uint8Array(await new Response(got.body).arrayBuffer()) : null;
  };

  async function updateTo(itemId: string, version: string): Promise<PlatformUpdatePreview> {
    const r = await env.root({
      method: "POST",
      url: `/api/v1/admin/catalog/items/${itemId}/update/preview`,
      payload: { version },
    });
    expect(r.statusCode, r.body).toBe(200);
    const p = r.json() as PlatformUpdatePreview;
    const c = await env.root({
      method: "PUT",
      url: `/api/v1/admin/catalog/items/${itemId}/update`,
      payload: { version, diffHash: p.diffHash },
    });
    expect(c.statusCode, c.body).toBe(200);
    return p;
  }

  it("a themes-only plugin imports into one platform theme with its assets in storage", async () => {
    const r = await prepare(await themePlugin("neon"));
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().review.themes).toEqual([
      {
        id: "neon-grid",
        name: { en: "Neon Grid", zh: "霓虹网格" },
        schemes: ["dark"],
        fonts: 1,
        logo: true,
      },
    ]);
    const itemId = await importPlugin(env, await themePlugin("neon"));
    const row = await themeRow();
    expect(row).toMatchObject({
      catalog_item_id: itemId,
      plugin_name: "neon",
      description: "Neon on black.",
      description_zh: "黑底霓虹。",
      current_version: 1,
      scope_mode: "follow",
      owner_org_id: null,
      deleted_at: null,
    });
    // Both texts reach the admin list, so the web picks one by UI language (browser review F08).
    const list = await env.root({ method: "GET", url: "/api/v1/admin/components?kind=theme" });
    expect(list.statusCode, list.body).toBe(200);
    expect(
      (list.json() as { components: { id: string }[] }).components.find((c) => c.id === row.id),
    ).toMatchObject({ description: "Neon on black.", descriptionZh: "黑底霓虹。" });
    const v = await versionRow(row.id, 1);
    expect(v.catalog_version).toBe("1.0.0");
    expect(v.object_prefix).toMatch(/^platform\/themes\/sha256-[0-9a-f]{64}\/$/);
    expect(v.definition).toMatchObject({ id: "neon-grid", logo: { wordmark: "NEON GRID" } });
    expect(await stored(`${v.object_prefix}fonts/Fixture-Regular.woff2`)).toEqual(FONT);
    const logo = new TextDecoder().decode(
      (await stored(`${v.object_prefix}logo.svg`)) ?? undefined,
    );
    expect(logo).toBe((sanitizeThemeSvg(enc(LOGO)) as { svg: string }).svg);
    expect(logo).not.toContain("editor");
  });

  it("an org upload of a themes-only plugin installs at once and passes the custom deny", async () => {
    await setDeployment(env, { customSkills: "deny", customConnectors: "deny" });
    const base = `/api/v1/orgs/${env.orgId}/catalog/uploads`;
    const up = await env.boss({
      method: "POST",
      url: `${base}/file`,
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from(await themePlugin("org-neon")),
    });
    expect(up.statusCode, up.body).toBe(200);
    const p = up.json() as { stagingId: string; review: { reviewHash: string } };
    const c = await env.boss({
      method: "POST",
      url: `${base}/${p.stagingId}/confirm`,
      payload: { reviewHash: p.review.reviewHash },
    });
    expect(c.statusCode, c.body).toBe(201);
    const body = c.json() as { item: { id: string; scope: string }; outcome: string };
    expect(body.outcome).toBe("installed");
    expect(body.item.scope).toBe("named");
    const listed = await env.db
      .selectFrom("catalog_item_scope_orgs")
      .select("org_id")
      .where("item_id", "=", body.item.id)
      .execute();
    expect(listed.map((x) => x.org_id)).toEqual([env.orgId]);
    expect(await themeRow()).toMatchObject({
      catalog_item_id: body.item.id,
      owner_org_id: env.orgId,
      origin_org_id: env.orgId,
      shareable: false,
      shown_to_others: false,
    });
    // the plugin's shareable switch reaches its theme
    const share = await env.boss({
      method: "PUT",
      url: `/api/v1/orgs/${env.orgId}/owned-plugins/${body.item.id}/shareable`,
      payload: { shareable: true },
    });
    expect(share.statusCode, share.body).toBe(204);
    expect((await themeRow()).shareable).toBe(true);
  });

  it("an unreadable theme refuses the plugin and nothing is staged", async () => {
    const r = await prepare(await themePlugin("grey", { themeJson: theme({}, { bg: "#8E8E89" }) }));
    expect(r.statusCode, r.body).toBe(400);
    const err = r.json().error as {
      code: string;
      details: { theme: string; issues: string[] }[];
    };
    expect(err.code).toBe("theme.unreadable");
    expect(err.details[0]?.theme).toBe("neon-grid");
    expect(err.details[0]?.issues.some((i) => i.includes("muted on bg"))).toBe(true);
    expect(await env.db.selectFrom("plugin_import_staging").select("id").execute()).toEqual([]);
    expect(await env.db.selectFrom("catalog_items").select("id").execute()).toEqual([]);
  });

  it("an invalid theme refuses the plugin with theme.invalid", async () => {
    const r = await prepare(
      await themePlugin("bad", { themeJson: theme({}, { "no-such-token": "#000000" }) }),
    );
    expect(r.statusCode, r.body).toBe(400);
    const err = r.json().error as { code: string; details: { theme: string; errors: string[] }[] };
    expect(err.code).toBe("theme.invalid");
    expect(err.details).toEqual([
      { theme: "neon-grid", errors: [expect.stringContaining("no-such-token")] },
    ]);
  });

  it("updates move the theme to a new version when its file or an asset changed, and remove it", async () => {
    const itemId = await importPlugin(env, await themePlugin("neon"));
    const first = await themeRow();

    await importPlugin(
      env,
      await themePlugin("neon", {
        version: "2.0.0",
        themeJson: theme({}, { accent: "#FFD000" }),
      }),
    );
    const p2 = await updateTo(itemId, "2.0.0");
    expect(p2.components).toEqual([
      expect.objectContaining({
        kind: "theme",
        id: first.id,
        name: "neon-grid",
        change: "upgrade",
        from: "1.0.0",
        to: "2.0.0",
      }),
    ]);
    expect((await themeRow()).current_version).toBe(2);
    const v2 = await versionRow(first.id, 2);
    // only the definition changed: the assets' objects (keyed by content) are shared
    expect(v2.object_prefix).toBe((await versionRow(first.id, 1)).object_prefix);
    expect(v2.definition).toMatchObject({ schemes: { dark: { color: { accent: "#FFD000" } } } });

    // the same file, a changed font: still a new version
    const font = enc("wOF2-changed");
    await importPlugin(
      env,
      await themePlugin("neon", {
        version: "3.0.0",
        themeJson: theme({}, { accent: "#FFD000" }),
        font,
      }),
    );
    const p3 = await updateTo(itemId, "3.0.0");
    expect(p3.components[0]).toMatchObject({ kind: "theme", change: "upgrade" });
    expect((await themeRow()).current_version).toBe(3);
    const v3 = await versionRow(first.id, 3);
    expect(v3.object_prefix).not.toBe(v2.object_prefix);
    expect(await stored(`${v3.object_prefix}fonts/Fixture-Regular.woff2`)).toEqual(font);

    // the same content again: unchanged
    await importPlugin(
      env,
      await themePlugin("neon", {
        version: "3.1.0",
        themeJson: theme({}, { accent: "#FFD000" }),
        font,
      }),
    );
    const p31 = await updateTo(itemId, "3.1.0");
    expect(p31.components[0]).toMatchObject({ kind: "theme", change: "same" });
    expect((await themeRow()).current_version).toBe(3);

    // a version without the theme removes it
    await importPlugin(
      env,
      await themePlugin("neon", {
        version: "4.0.0",
        noTheme: true,
        extra: { "skills/notes/SKILL.md": SKILL_MD("notes") },
      }),
    );
    const p4 = await updateTo(itemId, "4.0.0");
    expect(p4.components.find((c) => c.kind === "theme")).toMatchObject({
      change: "removed",
      to: null,
    });
    expect((await themeRow()).deleted_at).not.toBeNull();
  });

  it("an update to an unreadable theme is refused before it applies", async () => {
    const itemId = await importPlugin(env, await themePlugin("neon"));
    const r = await prepare(
      await themePlugin("neon", { version: "2.0.0", themeJson: theme({}, { bg: "#8E8E89" }) }),
    );
    expect(r.statusCode, r.body).toBe(400);
    expect(r.json().error.code).toBe("theme.unreadable");
    expect((await themeRow()).current_version).toBe(1);
    expect(itemId).toBeTruthy();
  });

  /**
   * Replaces a stored file of catalog version `version` of `itemId` (and its recorded hash), as a
   * version accepted by an older core reads after a release changed the built-in tokens.
   */
  async function rewriteCatalogFile(itemId: string, version: string, path: string, text: string) {
    const v = await env.db
      .selectFrom("catalog_item_versions")
      .select(["object_prefix", "files"])
      .where("item_id", "=", itemId)
      .where("version", "=", version)
      .executeTakeFirstOrThrow();
    const data = enc(text);
    await env.k.app.get(StorageService).deployment().put(`${v.object_prefix}${path}`, data, {
      contentType: "application/octet-stream",
      size: data.byteLength,
    });
    const sha256 = createHash("sha256").update(data).digest("hex");
    await env.db
      .updateTable("catalog_item_versions")
      .set({
        files: JSON.stringify(
          v.files.map((f) => (f.path === path ? { path, size: data.byteLength, sha256 } : f)),
        ),
      })
      .where("item_id", "=", itemId)
      .where("version", "=", version)
      .execute();
  }

  it("a stored version holds only the theme file's own values (no built-in values)", async () => {
    await importPlugin(env, await themePlugin("neon"));
    const v = await versionRow((await themeRow()).id, 1);
    const def = v.definition as ParsedTheme;
    expect(def).not.toHaveProperty("merged");
    expect(def.schemes).toEqual({
      dark: {
        color: { bg: "#05070D", panel: "#0A0E18", accent: "#FCE300", "on-accent": "#141200" },
        radius: { sm: 0, md: 2 },
      },
    });
  });

  it("a catalog version is not judged for readability again: its import verdict holds", async () => {
    const itemId = await importPlugin(env, await themePlugin("neon"));
    await importPlugin(
      env,
      await themePlugin("neon", { version: "2.0.0", themeJson: theme({}, { accent: "#FFD000" }) }),
    );
    // after import, the current built-ins would find 2.0.0's theme unreadable (a tightened floor)
    await rewriteCatalogFile(
      itemId,
      "2.0.0",
      "themes/neon-grid.json",
      theme({}, { accent: "#FFD000", bg: "#8E8E89" }),
    );
    await updateTo(itemId, "2.0.0");
    expect((await themeRow()).current_version).toBe(2);
    // grammar and token names are still checked on read
    await importPlugin(env, await themePlugin("neon", { version: "3.0.0" }));
    await rewriteCatalogFile(
      itemId,
      "3.0.0",
      "themes/neon-grid.json",
      theme({}, { "renamed-away": "#000000" }),
    );
    const r = await env.root({
      method: "POST",
      url: `/api/v1/admin/catalog/items/${itemId}/update/preview`,
      payload: { version: "3.0.0" },
    });
    expect(r.statusCode, r.body).toBe(400);
    expect(r.json().error.code).toBe("theme.invalid");
  });

  it("removing the plugin removes its theme", async () => {
    const itemId = await importPlugin(env, await themePlugin("neon"));
    expect((await themeRow()).deleted_at).toBeNull();
    const del = await env.root({ method: "DELETE", url: `/api/v1/admin/catalog/items/${itemId}` });
    expect(del.statusCode, del.body).toBe(204);
    expect((await themeRow()).deleted_at).not.toBeNull();
  });
});
