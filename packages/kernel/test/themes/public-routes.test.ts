import { sanitizeThemeSvg, THEME_TOKENS } from "@capybara-hq/plugin-sdk";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { THEME_CSS_REVISION } from "../../src/themes/theme-state.js";
import { importPlugin, type OrgEnv, resetOrgCatalog, startOrgEnv } from "../catalog/org-env.js";
import { pluginTgz } from "../helpers/plugin-packages.js";
import { clearThemeLevels, setThemeScope, writeUiTheme } from "./theme-env.js";

/** The render revision segment of a theme stylesheet URL. */
const REV = `r${THEME_CSS_REVISION}`;

/**
 * Themes spec §8-§9 (plan Task 9): a theme version's stylesheet and assets, and the platform
 * default for pages before sign-in, are public; the stylesheet and assets are immutable per
 * version; an unknown theme, version or file is 404 `theme.not_found`.
 */

const enc = (s: string) => new TextEncoder().encode(s);
const FONT = enc("wOF2-fixture");
const LOGO =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><!-- x --><rect width="10" height="10"/></svg>';

/** A PNG header (signature + IHDR) of 64 x 64. */
function png(): Uint8Array {
  const b = new Uint8Array(64);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const v = new DataView(b.buffer);
  v.setUint32(8, 13);
  b.set(enc("IHDR"), 12);
  v.setUint32(16, 64);
  v.setUint32(20, 64);
  return b;
}
const PNG = png();

const IMMUTABLE = "public, max-age=31536000, immutable";

describe("theme delivery routes", () => {
  let env: OrgEnv;
  let id: string;

  /** An anonymous request (no cookie, no token). */
  const anon = (url: string) => env.k.http.inject({ method: "GET", url });

  beforeAll(async () => {
    env = await startOrgEnv();
  }, 240_000);

  afterAll(async () => {
    await env?.stop();
  });

  beforeEach(async () => {
    await resetOrgCatalog(env);
    await clearThemeLevels(env);
    const bytes = await pluginTgz({
      manifest: { name: "neon" },
      files: {
        "themes/neon-grid.json": JSON.stringify({
          name: { en: "Neon Grid", zh: "霓虹网格" },
          schemes: {
            dark: {
              color: { bg: "#05070D", panel: "#0A0E18", accent: "#FCE300", "on-accent": "#141200" },
            },
          },
          fonts: [{ family: "MiSans", file: "./fonts/MiSans.woff2", weight: 400, role: "prose" }],
          logo: { mark: "./brand/logo.svg", wordmark: "NEON GRID", favicon: "./brand/icon.png" },
        }),
        "fonts/MiSans.woff2": FONT,
        "brand/logo.svg": LOGO,
        "brand/icon.png": PNG,
      },
    });
    const itemId = await importPlugin(env, bytes);
    id = (
      await env.db
        .selectFrom("platform_themes")
        .select("id")
        .where("catalog_item_id", "=", itemId)
        .executeTakeFirstOrThrow()
    ).id;
  });

  it("GET theme.css: the stylesheet without a session, immutable", async () => {
    const r = await anon(`/api/v1/themes/${id}/1/${REV}/theme.css`);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.headers["content-type"]).toBe("text/css; charset=utf-8");
    expect(r.headers["cache-control"]).toBe(IMMUTABLE);
    expect(r.body).toContain(':root[data-theme="dark"] {');
    expect(r.body).toContain(':root[data-theme="light"] {');
    expect(r.body).toContain("color-scheme: dark;");
    expect(r.body).toContain("--cb-accent: #FCE300;");
    expect(r.body).toContain(`url("/api/v1/themes/${id}/1/assets/fonts%2FMiSans.woff2")`);
    expect(r.body).toContain('--cb-font-prose: "MiSans", ');
  });

  it("the stylesheet URL carries the render revision; the URL without one is not served", async () => {
    // THEME_CSS_REVISION 2: the stylesheet became one `@layer theme` block (client extensions
    // spec §7.2). A browser holding the revision-less URL cached (immutable) has the unlayered
    // format; the layered output never answers that URL, least of all with an immutable cache.
    await setThemeScope(env, id, "all");
    await writeUiTheme(env, id);
    const ref = (await anon("/api/v1/platform/theme")).json() as { cssUrl: string };
    expect(ref.cssUrl).toBe(`/api/v1/themes/${id}/1/r${THEME_CSS_REVISION}/theme.css`);
    const current = await anon(ref.cssUrl);
    expect(current.statusCode).toBe(200);
    expect(current.headers["cache-control"]).toBe(IMMUTABLE);
    expect(current.body.startsWith("@layer theme {")).toBe(true);
    const old = await anon(`/api/v1/themes/${id}/1/theme.css`);
    expect(old.statusCode).toBe(404);
    expect(old.headers["cache-control"]).not.toBe(IMMUTABLE);
    expect(old.body).not.toContain("@layer theme");
  });

  it("a database row changed after import renders without the tampered value", async () => {
    await sql`UPDATE capybara.platform_theme_versions
      SET definition = jsonb_set(definition, '{schemes,dark,color,bg}', '"#000;}x{"')
      WHERE theme_id = ${id}`.execute(env.db);
    const r = await anon(`/api/v1/themes/${id}/1/${REV}/theme.css`);
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain("x{");
    expect(r.body).toContain(`--cb-bg: ${THEME_TOKENS.color.bg.dark};`);
    expect(r.body).toContain("--cb-accent: #FCE300;");
  });

  it("GET assets: every URL the theme reference builds answers, with its type", async () => {
    await setThemeScope(env, id, "all");
    await writeUiTheme(env, id);
    const ref = (await anon("/api/v1/platform/theme")).json();
    const css = (await anon(ref.cssUrl)).body;
    const fontUrl = /url\("([^"]+)"\)/.exec(css)?.[1] as string;

    const font = await anon(fontUrl);
    expect(font.statusCode).toBe(200);
    expect(font.headers["content-type"]).toBe("font/woff2");
    expect(font.headers["cache-control"]).toBe(IMMUTABLE);
    expect(new Uint8Array(font.rawPayload)).toEqual(FONT);

    const mark = await anon(ref.logo.markUrl);
    expect(mark.statusCode).toBe(200);
    expect(mark.headers["content-type"]).toBe("image/svg+xml");
    expect(mark.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
    expect(mark.headers["x-content-type-options"]).toBe("nosniff");
    expect(mark.headers["cache-control"]).toBe(IMMUTABLE);
    expect(mark.body).toBe((sanitizeThemeSvg(enc(LOGO)) as { svg: string }).svg);
    expect(mark.body).not.toContain("<!--");

    const icon = await anon(ref.logo.faviconUrl);
    expect(icon.statusCode).toBe(200);
    expect(icon.headers["content-type"]).toBe("image/png");
    expect(icon.headers["x-content-type-options"]).toBe("nosniff");
    expect(new Uint8Array(icon.rawPayload)).toEqual(PNG);
  });

  it("unknown theme, version or file -> 404 theme.not_found", async () => {
    for (const url of [
      `/api/v1/themes/00000000-0000-0000-0000-000000000000/1/${REV}/theme.css`,
      `/api/v1/themes/not-a-uuid/1/${REV}/theme.css`,
      `/api/v1/themes/${id}/2/${REV}/theme.css`,
      `/api/v1/themes/${id}/abc/${REV}/theme.css`,
      `/api/v1/themes/${id}/99999999999999999999/${REV}/theme.css`,
      // Only the current render revision is served: an older one promised another format, a
      // later one is a newer replica's URL
      `/api/v1/themes/${id}/1/r${THEME_CSS_REVISION - 1}/theme.css`,
      `/api/v1/themes/${id}/1/r${THEME_CSS_REVISION + 1}/theme.css`,
      `/api/v1/themes/${id}/1/2/theme.css`,
      `/api/v1/themes/${id}/1/assets/fonts%2FOther.woff2`,
      `/api/v1/themes/${id}/1/assets/themes%2Fneon-grid.json`,
      `/api/v1/themes/${id}/1/assets/..%2F..%2Fsecret.png`,
      `/api/v1/themes/${id}/2/assets/fonts%2FMiSans.woff2`,
    ]) {
      const r = await anon(url);
      expect(r.statusCode, url).toBe(404);
      expect(r.json().error.code, url).toBe("theme.not_found");
    }
  });

  it("a removed theme's versions are still served (their URLs are immutable)", async () => {
    await env.db
      .updateTable("platform_themes")
      .set({ deleted_at: new Date() })
      .where("id", "=", id)
      .execute();
    expect((await anon(`/api/v1/themes/${id}/1/${REV}/theme.css`)).statusCode).toBe(200);
    expect((await anon(`/api/v1/themes/${id}/1/assets/fonts%2FMiSans.woff2`)).statusCode).toBe(200);
  });

  it("GET /api/v1/platform/theme: null when uiTheme is unset, the reference when set; no-store", async () => {
    const none = await anon("/api/v1/platform/theme");
    expect(none.statusCode).toBe(200);
    expect(none.headers["cache-control"]).toBe("no-store");
    expect(none.json()).toBeNull();

    await setThemeScope(env, id, "all");
    await writeUiTheme(env, id);
    const set = await anon("/api/v1/platform/theme");
    expect(set.statusCode).toBe(200);
    expect(set.headers["cache-control"]).toBe("no-store");
    expect(set.json()).toMatchObject({
      id,
      version: "1",
      singleScheme: "dark",
      cssUrl: `/api/v1/themes/${id}/1/${REV}/theme.css`,
      logo: {
        markUrl: `/api/v1/themes/${id}/1/assets/brand%2Flogo.svg`,
        wordmark: "NEON GRID",
        faviconUrl: `/api/v1/themes/${id}/1/assets/brand%2Ficon.png`,
      },
    });
  });
});
