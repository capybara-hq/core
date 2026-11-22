import { THEME_TOKENS } from "@capybara-hq/plugin-sdk";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { THEME_CSS_REVISION } from "../../src/themes/theme-state.js";
import { ThemesService } from "../../src/themes/themes.service.js";
import { importPlugin, type OrgEnv, resetOrgCatalog, startOrgEnv } from "../catalog/org-env.js";
import { pluginTgz } from "../helpers/plugin-packages.js";
import {
  clearThemeLevels,
  importTheme,
  setThemeScope,
  setThemeSwitch,
  writeOrgTheme,
  writeUiTheme,
} from "./theme-env.js";

/**
 * Themes spec §7 (plan Task 8): the theme of a signed-in page is the person's pick if it is on in
 * the org and the org does not lock; else the org's default if on; else the platform default if on
 * in the org; else the built-in theme (null). An unavailable choice is skipped, never an error.
 *
 * The second suite is client extensions spec §7.3: `ThemeRef.key` names a theme for the `theme=`
 * state token. Both suites share one org environment.
 */
let env: OrgEnv;
let themes: ThemesService;

beforeAll(async () => {
  env = await startOrgEnv();
  themes = env.k.app.get(ThemesService);
});

afterAll(async () => {
  await env?.stop();
});

describe("theme resolution", () => {
  /** Three themes with their own scope `all` (on in the org). */
  let a: string;
  let b: string;
  let c: string;

  beforeEach(async () => {
    await resetOrgCatalog(env);
    await clearThemeLevels(env);
    a = (await importTheme(env, "neon", "neon-grid")).id;
    b = (await importTheme(env, "paper", "paper", "both")).id;
    c = (await importTheme(env, "dusk", "dusk", "both")).id;
    for (const id of [a, b, c]) await setThemeScope(env, id, "all");
  });

  const pick = (accountId: string, id: string | null) =>
    env.db.updateTable("accounts").set({ theme: id }).where("id", "=", accountId).execute();

  it("the person's pick, when it is on in the org", async () => {
    await pick(env.memId, a);
    await writeOrgTheme(env, env.orgId, { id: b, personal: "allowed" });
    const r = await themes.resolve(env.orgId, env.memId);
    expect(r).toEqual({
      id: a,
      key: "neon/neon-grid",
      version: "1",
      name: { en: "neon-grid en", zh: "neon-grid zh" },
      schemes: ["dark"],
      singleScheme: "dark",
      logo: {
        markUrl: `/api/v1/themes/${a}/1/assets/brand%2Flogo.svg`,
        wordmark: "NEON GRID",
        faviconUrl: null,
        illustrationUrl: null,
        appIconUrl: null,
        appIconMaskableUrl: null,
      },
      decoration: "dither",
      background: { dark: "#05070D" },
      cssUrl: `/api/v1/themes/${a}/1/r${THEME_CSS_REVISION}/theme.css`,
    });
  });

  it("the org's default when the person's pick is off in the org", async () => {
    await pick(env.memId, a);
    await setThemeSwitch(env, env.orgId, a, false);
    await writeOrgTheme(env, env.orgId, { id: b, personal: "allowed" });
    expect((await themes.resolve(env.orgId, env.memId))?.id).toBe(b);
  });

  it("the org's default when the org locks, even with a pick that is on", async () => {
    await pick(env.memId, a);
    await writeOrgTheme(env, env.orgId, { id: b, personal: "locked" });
    expect((await themes.resolve(env.orgId, env.memId))?.id).toBe(b);
  });

  it("the platform default when the org's default is off in the org", async () => {
    await writeOrgTheme(env, env.orgId, { id: b, personal: "allowed" });
    await setThemeSwitch(env, env.orgId, b, false);
    await writeUiTheme(env, c);
    expect((await themes.resolve(env.orgId, env.memId))?.id).toBe(c);
  });

  it("the built-in theme (null) when no level chose one", async () => {
    await writeUiTheme(env, null);
    expect(await themes.resolve(env.orgId, env.memId)).toBeNull();
  });

  it("null, not an error, when the platform default is not on in the org", async () => {
    await writeUiTheme(env, c);
    // impossible through the guards (the default is locked on); simulated by a direct row edit
    await setThemeSwitch(env, env.orgId, c, false);
    expect(await themes.resolve(env.orgId, env.memId)).toBeNull();
  });

  it("GET /orgs/:orgId/themes lists the themes on in the org with swatches, the viewer's theme and the org's setting", async () => {
    await setThemeSwitch(env, env.orgId, c, false);
    await pick(env.memId, b);
    await writeOrgTheme(env, env.orgId, { id: a, personal: "allowed" });
    const r = await env.mem({ method: "GET", url: `/api/v1/orgs/${env.orgId}/themes` });
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json() as {
      themes: { id: string; swatches: Record<string, unknown>; cssUrl: string }[];
      resolved: { id: string } | null;
      org: unknown;
    };
    expect(body.themes.map((t) => t.id)).toEqual([a, b]);
    expect(body.themes[0]?.swatches).toEqual({
      dark: { bg: "#05070D", panel: "#0A0E18", ink: expect.any(String), accent: "#FCE300" },
    });
    expect(Object.keys(body.themes[1]?.swatches ?? {}).sort()).toEqual(["dark", "light"]);
    expect(body.resolved).toMatchObject({
      id: b,
      cssUrl: `/api/v1/themes/${b}/1/r${THEME_CSS_REVISION}/theme.css`,
    });
    expect(body.resolved).not.toHaveProperty("swatches");
    expect(body.org).toEqual({ id: a, personal: "allowed" });
    // another member with no pick gets the org's default; the org with no setting reads as allowed
    const boss = await env.boss({ method: "GET", url: `/api/v1/orgs/${env.orgId}/themes` });
    expect(boss.json().resolved).toMatchObject({ id: a });
  });

  it("GET /orgs/:orgId/themes and GET /platform/theme carry decoration and background", async () => {
    // A two-scheme theme that turns the decoration off and overrides only the dark bg
    const itemId = await importPlugin(
      env,
      await pluginTgz({
        manifest: { name: "plain" },
        files: {
          "themes/plain.json": JSON.stringify({
            name: { en: "Plain", zh: "素" },
            schemes: { dark: { color: { bg: "#101010" } }, light: { radius: { md: 4 } } },
            decoration: "none",
          }),
        },
      }),
    );
    const d = (
      await env.db
        .selectFrom("platform_themes")
        .select("id")
        .where("catalog_item_id", "=", itemId)
        .executeTakeFirstOrThrow()
    ).id;
    await setThemeScope(env, d, "all");
    await writeUiTheme(env, d);

    const r = await env.mem({ method: "GET", url: `/api/v1/orgs/${env.orgId}/themes` });
    expect(r.statusCode, r.body).toBe(200);
    const listed = (
      r.json() as { themes: { id: string; decoration: string; background: object }[] }
    ).themes;
    const of = (id: string) => listed.find((t) => t.id === id);
    // a: dark only with its own bg; b: both schemes, no bg override (the built-in values)
    expect(of(a)).toMatchObject({ decoration: "dither", background: { dark: "#05070D" } });
    expect(of(a)?.background).not.toHaveProperty("light");
    expect(of(b)).toMatchObject({
      decoration: "dither",
      background: { dark: THEME_TOKENS.color.bg.dark, light: THEME_TOKENS.color.bg.light },
    });
    expect(of(d)).toMatchObject({
      decoration: "none",
      background: { dark: "#101010", light: THEME_TOKENS.color.bg.light },
    });

    const p = await env.k.http.inject({ method: "GET", url: "/api/v1/platform/theme" });
    expect(p.statusCode, p.body).toBe(200);
    expect(p.json()).toMatchObject({
      id: d,
      decoration: "none",
      background: { dark: "#101010", light: THEME_TOKENS.color.bg.light },
    });
  });

  it("the platform default for anonymous pages, only while it is eligible", async () => {
    await writeUiTheme(env, c);
    expect((await themes.platformDefault())?.id).toBe(c);
    await setThemeScope(env, c, "optional");
    expect(await themes.platformDefault()).toBeNull();
  });
});

describe("ThemeRef.key", () => {
  beforeEach(async () => {
    await resetOrgCatalog(env);
    await clearThemeLevels(env);
  });

  it("ThemeRef.key is plugin/file id", async () => {
    const { id } = await importTheme(env, "neon", "neon-grid");
    await setThemeScope(env, id, "all");
    await writeUiTheme(env, id);
    // The listing, the platform default and the resolved theme all carry the same key (not the
    // `platform_themes` uuid).
    expect((await themes.listForOrg(env.orgId)).map((t) => t.key)).toEqual(["neon/neon-grid"]);
    expect((await themes.platformDefault())?.key).toBe("neon/neon-grid");
    expect((await themes.resolve(env.orgId, env.memId))?.key).toBe("neon/neon-grid");
  });
});

describe("theme avatar presets", () => {
  const SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';

  /**
   * Imports plugin `plugin` with theme `themeId`: two avatar presets and two hidden built-ins
   * (listed out of the built-in order). Returns the theme's `platform_themes` id, scope `all`.
   */
  async function importAvatarTheme(plugin: string, themeId: string): Promise<string> {
    const itemId = await importPlugin(
      env,
      await pluginTgz({
        manifest: { name: plugin },
        files: {
          [`themes/${themeId}.json`]: JSON.stringify({
            name: { en: `${themeId} en`, zh: `${themeId} zh` },
            schemes: { dark: { radius: { sm: 2 } } },
            avatars: [
              { id: "mascot", name: { en: "Mascot", zh: "吉祥物" }, file: "./avatars/mascot.svg" },
              { id: "robot-2", name: { en: "Robot" }, file: "avatars/robot.svg" },
            ],
            hideAvatarPresets: ["panda", "capybara"],
          }),
          "avatars/mascot.svg": SVG,
          "avatars/robot.svg": SVG,
        },
      }),
    );
    const { id } = await env.db
      .selectFrom("platform_themes")
      .select("id")
      .where("catalog_item_id", "=", itemId)
      .executeTakeFirstOrThrow();
    await setThemeScope(env, id, "all");
    return id;
  }

  let a: string;
  let b: string;

  beforeEach(async () => {
    await resetOrgCatalog(env);
    await clearThemeLevels(env);
    await writeUiTheme(env, null);
    a = await importAvatarTheme("brand", "brand-grid");
    b = await importAvatarTheme("other", "other-paper");
  });

  const keys = (r: { presets: { key: string }[] }) => r.presets.map((p) => p.key);

  it("avatars come from the org default, not the viewer's pick", async () => {
    await env.db.updateTable("accounts").set({ theme: b }).where("id", "=", env.memId).execute();
    await writeOrgTheme(env, env.orgId, { id: a, personal: "allowed" });
    // the viewer resolves to their own pick, but the avatars are the org default's
    expect((await themes.resolve(env.orgId, env.memId))?.id).toBe(b);
    expect((await themes.orgDefault(env.orgId))?.id).toBe(a);
    expect(keys(await themes.avatarPresets(env.orgId))).toEqual([
      "brand/brand-grid/mascot",
      "brand/brand-grid/robot-2",
    ]);
    const r = await env.mem({ method: "GET", url: `/api/v1/orgs/${env.orgId}/themes` });
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json() as { resolved: { id: string }; avatars: { presets: { key: string }[] } };
    expect(body.resolved.id).toBe(b);
    expect(keys(body.avatars)).toEqual(["brand/brand-grid/mascot", "brand/brand-grid/robot-2"]);
  });

  it("the platform default applies when the org follows it", async () => {
    await writeUiTheme(env, b);
    expect((await themes.orgDefault(env.orgId))?.id).toBe(b);
    expect(keys(await themes.avatarPresets(env.orgId))).toEqual([
      "other/other-paper/mascot",
      "other/other-paper/robot-2",
    ]);
  });

  it("a default theme that is off in the org gives no presets and hides nothing", async () => {
    await writeOrgTheme(env, env.orgId, { id: a, personal: "allowed" });
    await writeUiTheme(env, b);
    await setThemeSwitch(env, env.orgId, a, false);
    await setThemeSwitch(env, env.orgId, b, false);
    expect(await themes.orgDefault(env.orgId)).toBeNull();
    expect(await themes.avatarPresets(env.orgId)).toEqual({ hidden: [], presets: [] });
    expect((await themes.forOrg(env.orgId, env.memId)).avatars).toEqual({
      hidden: [],
      presets: [],
    });
    // the platform default takes over once the org's default is off but the platform's is on
    await setThemeSwitch(env, env.orgId, b, true);
    expect((await themes.orgDefault(env.orgId))?.id).toBe(b);
  });

  it("keys are plugin/theme/preset and urls are delivery URLs", async () => {
    await writeOrgTheme(env, env.orgId, { id: a, personal: "locked" });
    expect(await themes.avatarPresets(env.orgId)).toEqual({
      // in the built-in order, not the theme file's
      hidden: ["capybara", "panda"],
      presets: [
        {
          key: "brand/brand-grid/mascot",
          name: { en: "Mascot", zh: "吉祥物" },
          url: `/api/v1/themes/${a}/1/assets/avatars%2Fmascot.svg`,
          themeId: a,
          version: "1",
          preset: "mascot",
          file: "./avatars/mascot.svg",
        },
        {
          key: "brand/brand-grid/robot-2",
          // no zh: readers fall back to en
          name: { en: "Robot", zh: "Robot" },
          url: `/api/v1/themes/${a}/1/assets/avatars%2Frobot.svg`,
          themeId: a,
          version: "1",
          preset: "robot-2",
          file: "avatars/robot.svg",
        },
      ],
    });
    // the public listing carries only key, name and url
    expect((await themes.forOrg(env.orgId, null)).avatars).toEqual({
      hidden: ["capybara", "panda"],
      presets: [
        {
          key: "brand/brand-grid/mascot",
          name: { en: "Mascot", zh: "吉祥物" },
          url: `/api/v1/themes/${a}/1/assets/avatars%2Fmascot.svg`,
        },
        {
          key: "brand/brand-grid/robot-2",
          name: { en: "Robot", zh: "Robot" },
          url: `/api/v1/themes/${a}/1/assets/avatars%2Frobot.svg`,
        },
      ],
    });
    // the delivery route serves the file at that URL
    const f = await env.mem({
      method: "GET",
      url: `/api/v1/themes/${a}/1/assets/avatars%2Fmascot.svg`,
    });
    expect(f.statusCode, f.body).toBe(200);
  });

  it("a theme row without provenance offers no presets but still hides built-ins", async () => {
    await env.db
      .updateTable("platform_themes")
      .set({ plugin_name: null })
      .where("id", "=", a)
      .execute();
    await writeOrgTheme(env, env.orgId, { id: a, personal: "allowed" });
    expect(await themes.avatarPresets(env.orgId)).toEqual({
      hidden: ["capybara", "panda"],
      presets: [],
    });
  });
});
