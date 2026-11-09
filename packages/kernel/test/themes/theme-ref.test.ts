import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ThemesService } from "../../src/themes/themes.service.js";
import { type OrgEnv, resetOrgCatalog, startOrgEnv } from "../catalog/org-env.js";
import { clearThemeLevels, importTheme, setThemeScope, writeUiTheme } from "./theme-env.js";

/** Client extensions spec §7.3: `ThemeRef.key` names a theme for the `theme=` state token. */
describe("ThemeRef.key", () => {
  let env: OrgEnv;
  let themes: ThemesService;

  beforeAll(async () => {
    env = await startOrgEnv();
    themes = env.k.app.get(ThemesService);
  }, 240_000);

  afterAll(async () => {
    await env?.stop();
  });

  beforeEach(async () => {
    await resetOrgCatalog(env);
    await clearThemeLevels(env);
  });

  it("ThemeRef.key is plugin/file id", async () => {
    const { id } = await importTheme(env, "neon", "night-city");
    await setThemeScope(env, id, "all");
    await writeUiTheme(env, id);
    // The listing, the platform default and the resolved theme all carry the same key (not the
    // `platform_themes` uuid).
    expect((await themes.listForOrg(env.orgId)).map((t) => t.key)).toEqual(["neon/night-city"]);
    expect((await themes.platformDefault())?.key).toBe("neon/night-city");
    expect((await themes.resolve(env.orgId, env.memId))?.key).toBe("neon/night-city");
  });
});
