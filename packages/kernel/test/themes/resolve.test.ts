import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { THEME_CSS_REVISION } from "../../src/themes/theme-state.js";
import { ThemesService } from "../../src/themes/themes.service.js";
import { type OrgEnv, resetOrgCatalog, startOrgEnv } from "../catalog/org-env.js";
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
      },
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
