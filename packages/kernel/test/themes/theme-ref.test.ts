import { type ParsedTheme, parseThemeFile, THEME_TOKENS } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { storedAssetRefs } from "../../src/themes/theme-delivery.service.js";
import { themeRefOf } from "../../src/themes/theme-state.js";

/**
 * Theme brand coverage spec §2 (#451): the theme reference carries the illustration and app icon
 * delivery URLs, the decoration (default applied) and the merged background of each scheme the
 * theme defines, all computed at read from the stored definition.
 */

const ID = "11111111-2222-4333-8444-555555555555";

const parse = (file: Record<string, unknown>): ParsedTheme => {
  const r = parseThemeFile("brand-kit", file);
  if ("errors" in r) throw new Error(r.errors.join("; "));
  return r;
};

const NAME = { en: "Brand Kit", zh: "品牌套件" };

describe("themeRefOf", () => {
  it("illustration and app icon URLs are delivery URLs", () => {
    const def = parse({
      name: NAME,
      schemes: { dark: { color: { bg: "#05070D" } } },
      logo: {
        mark: "./logo.svg",
        illustration: "./brand/illustration.svg",
        appIcon: "brand/app-512.png",
        appIconMaskable: "./brand/app-mask-512.png",
      },
    });
    const ref = themeRefOf(ID, "3", def, "fake-theme");
    expect(ref.logo).toEqual({
      markUrl: `/api/v1/themes/${ID}/3/assets/logo.svg`,
      wordmark: null,
      faviconUrl: null,
      illustrationUrl: `/api/v1/themes/${ID}/3/assets/brand%2Fillustration.svg`,
      appIconUrl: `/api/v1/themes/${ID}/3/assets/brand%2Fapp-512.png`,
      appIconMaskableUrl: `/api/v1/themes/${ID}/3/assets/brand%2Fapp-mask-512.png`,
    });
  });

  it("null URLs when unset", () => {
    const def = parse({
      name: NAME,
      schemes: { dark: { color: { bg: "#05070D" } } },
      logo: { wordmark: "BRAND" },
    });
    expect(themeRefOf(ID, "1", def, "fake-theme").logo).toEqual({
      markUrl: null,
      wordmark: "BRAND",
      faviconUrl: null,
      illustrationUrl: null,
      appIconUrl: null,
      appIconMaskableUrl: null,
    });
  });

  it("decoration defaults to dither", () => {
    const plain = parse({ name: NAME, schemes: { dark: { radius: { sm: 2 } } } });
    expect(themeRefOf(ID, "1", plain, null).decoration).toBe("dither");
    const none = parse({
      name: NAME,
      schemes: { dark: { radius: { sm: 2 } } },
      decoration: "none",
    });
    expect(themeRefOf(ID, "1", none, null).decoration).toBe("none");
    const dither = parse({
      name: NAME,
      schemes: { dark: { radius: { sm: 2 } } },
      decoration: "dither",
    });
    expect(themeRefOf(ID, "1", dither, null).decoration).toBe("dither");
  });

  it("background holds the merged bg of each defined scheme only", () => {
    // A dark-only theme: no `light` key at all; its bg in canonical form
    const darkOnly = parse({ name: NAME, schemes: { dark: { color: { bg: "#05070d" } } } });
    const dark = themeRefOf(ID, "1", darkOnly, null).background;
    expect(dark).toEqual({ dark: "#05070D" });
    expect(dark).not.toHaveProperty("light");

    // No bg override: the built-in value of that scheme
    const both = parse({
      name: NAME,
      schemes: { dark: { radius: { sm: 2 } }, light: { color: { bg: "#fafafa" } } },
    });
    const bg = themeRefOf(ID, "1", both, null).background;
    expect(bg.dark).toBe(THEME_TOKENS.color.bg.dark);
    expect(bg.light).toBe("#FAFAFA");
    expect(Object.keys(bg).sort()).toEqual(["dark", "light"]);
  });

  it("a stored logo ref that is not an asset path gets a null URL, no throw", () => {
    const def = parse({ name: NAME, schemes: { dark: { radius: { sm: 2 } } } });
    const tampered = {
      ...def,
      logo: { mark: 42, favicon: null, illustration: "../x.svg", appIcon: ["a.png"] },
    } as unknown as ParsedTheme;
    expect(themeRefOf(ID, "1", tampered, null).logo).toEqual({
      markUrl: null,
      wordmark: null,
      faviconUrl: null,
      illustrationUrl: null,
      appIconUrl: null,
      appIconMaskableUrl: null,
    });
    const nullLogo = { ...def, logo: null } as unknown as ParsedTheme;
    expect(themeRefOf(ID, "1", nullLogo, null).logo).toBeNull();
  });
});

/**
 * The asset route names files from the stored definition without re-parsing it: a field of the
 * wrong shape names nothing and never throws.
 */
describe("storedAssetRefs", () => {
  const base = parse({ name: NAME, schemes: { dark: { radius: { sm: 2 } } } });
  const refs = (patch: Record<string, unknown>) =>
    storedAssetRefs({ ...base, ...patch } as unknown as ParsedTheme);

  it("malformed fonts, logo and avatars name nothing", () => {
    for (const patch of [
      { fonts: "x" },
      { fonts: [null, { file: 1 }] },
      { logo: "x" },
      { logo: [] },
      { logo: { mark: null } },
      { avatars: {} },
    ]) {
      expect(refs(patch), JSON.stringify(patch)).toEqual([]);
    }
  });

  it("a null definition names nothing", () => {
    expect(storedAssetRefs(null as unknown as ParsedTheme)).toEqual([]);
  });

  it("well-formed refs are listed as stored", () => {
    expect(
      refs({
        fonts: [{ family: "A", file: "./fonts/A.woff2", weight: 400, role: "prose" }],
        logo: { mark: "./logo.svg", appIcon: "brand/app.png" },
        avatars: [{ id: "bot", name: { en: "Bot" }, file: "./brand/bot.svg" }],
      }),
    ).toEqual(["./fonts/A.woff2", "./logo.svg", "brand/app.png", "./brand/bot.svg"]);
  });
});
