import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  BUILTIN_AVATAR_PRESET_IDS,
  canonicalThemeValue,
  isThemeAssetPath,
  isThemeFontFamily,
  mergeThemeSchemes,
  type ParsedTheme,
  parseThemeFile,
  THEME_LIMITS,
  THEME_TOKENS,
  ThemeFileSchema,
  themeIdOf,
} from "../src/index.js";

/** The spec §4 example. */
const neonGrid = (): Record<string, unknown> => ({
  name: { en: "Neon Grid", zh: "霓虹网格" },
  description: { en: "Neon yellow on deep blue-black." },
  schemes: {
    dark: {
      color: { bg: "#05070D", panel: "#0A0E18", accent: "#FCE300", "on-accent": "#141200" },
      shadow: { "shadow-1": "0 0 12px rgba(0,240,255,.25)" },
      radius: { sm: 0, md: 2 },
    },
  },
  fonts: [{ family: "MiSans", file: "./fonts/MiSans-Regular.woff2", weight: 400, role: "prose" }],
  logo: { mark: "./logo.svg", wordmark: "NEON GRID" },
});

/** The spec §1 example: every brand field. */
const brandKit = (): Record<string, unknown> => ({
  name: { en: "Acme", zh: "Acme" },
  schemes: { dark: {} },
  logo: {
    mark: "./logo.svg",
    wordmark: "ACME",
    favicon: "./favicon.svg",
    illustration: "./empty.svg",
    appIcon: "./app-512.png",
    appIconMaskable: "./app-mask-512.png",
  },
  decoration: "none",
  avatars: [
    { id: "acme-bot", name: { en: "Acme bot", zh: "Acme 机器人" }, file: "./avatars/bot.png" },
  ],
  hideAvatarPresets: ["capybara"],
});

/** An avatar preset entry. */
const avatar = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: { en: "Avatar" },
  file: `./avatars/${id}.svg`,
  ...over,
});

/** A theme overriding one dark token group. */
const dark = (over: Record<string, unknown>): Record<string, unknown> => ({
  name: { en: "T", zh: "T" },
  schemes: { dark: over },
});

const parsed = (json: unknown, id = "neon-grid"): ParsedTheme => {
  const r = parseThemeFile(id, json);
  if ("errors" in r) throw new Error(r.errors.join("\n"));
  return r;
};

const errorsOf = (json: unknown, id = "t"): string[] => {
  const r = parseThemeFile(id, json);
  return "errors" in r ? r.errors : [];
};

describe("parseThemeFile", () => {
  it("parses the spec example: dark only is single-scheme", () => {
    const t = parsed(neonGrid());
    expect(t.id).toBe("neon-grid");
    expect(t.singleScheme).toBe("dark");
    // the parsed theme holds the file's own values only; the built-ins are merged at use time
    expect(t).not.toHaveProperty("merged");
    expect(t.schemes.dark?.color?.ink).toBeUndefined();
    const merged = mergeThemeSchemes(t);
    expect(Object.keys(merged)).toEqual(["dark"]);
    const m = merged.dark;
    expect(m?.color.bg).toBe("#05070D");
    // Tokens the theme leaves out keep the built-in value of that scheme.
    expect(m?.color.ink).toBe(THEME_TOKENS.color.ink.dark);
    expect(m?.color["accent-tint"]).toBe(THEME_TOKENS.color["accent-tint"].dark);
    expect(m?.radius).toEqual({ sm: 0, md: 2, bubble: THEME_TOKENS.radius.bubble });
    // Values are re-rendered from their parsed parts.
    expect(m?.shadow["shadow-1"]).toBe("0 0 12px rgba(0,240,255,0.25)");
    expect(t.schemes.dark?.shadow?.["shadow-1"]).toBe("0 0 12px rgba(0,240,255,0.25)");
    expect(t.fonts?.[0]?.family).toBe("MiSans");
    expect(t.logo?.wordmark).toBe("NEON GRID");
  });

  it("both schemes: not single-scheme", () => {
    const t = parsed({ name: { en: "T", zh: "T" }, schemes: { dark: {}, light: {} } });
    expect(t.singleScheme).toBeNull();
    expect(mergeThemeSchemes(t).light?.color.bg).toBe(THEME_TOKENS.color.bg.light);
  });

  it("accepts the file text, rejects invalid JSON and an oversized file", () => {
    expect(parsed(JSON.stringify(neonGrid())).singleScheme).toBe("dark");
    expect(errorsOf("{")[0]).toMatch(/not valid JSON/);
    const big = JSON.stringify({ ...neonGrid(), pad: "x".repeat(THEME_LIMITS.fileBytes) });
    expect(errorsOf(big)[0]).toMatch(/larger than 65536 bytes/);
    expect(errorsOf([])[0]).toMatch(/must be a JSON object/);
  });

  it("rejects an invalid id", () => {
    expect(errorsOf(neonGrid(), "Neon Grid")[0]).toMatch(/theme id/);
  });

  it("an avatar color is not overridable, naming the token", () => {
    const e = errorsOf(dark({ color: { "avatar-fox": "#000000" } }));
    expect(e.join("\n")).toMatch(/color\.avatar-fox/);
    expect(e.join("\n")).toMatch(/not overridable/);
  });

  it("a color-mix token is not overridable", () => {
    expect(errorsOf(dark({ color: { "accent-tint": "#000000" } })).join("\n")).toMatch(
      /token color\.accent-tint is not overridable/,
    );
  });

  it("an unknown token is an error", () => {
    expect(errorsOf(dark({ color: { nonexistent: "#000000" } })).join("\n")).toMatch(
      /unknown token color\.nonexistent/,
    );
    expect(errorsOf(dark({ shadow: { "shadow-9": "0 0 1px #000000" } })).join("\n")).toMatch(
      /unknown token shadow\.shadow-9/,
    );
  });

  it.each([
    "#000;}body{display:none",
    "</style>",
    "url(https://x.example/a.png)",
    "var(--cb-accent)",
    "expression(alert(1))",
    "#000",
    "#0000000",
    "red",
    "rgb(0,0,0)",
    "rgba(256,0,0,1)",
    "rgba(0,0,0,1.5)",
    "rgba(0,0,0,.5);}x{",
    "color-mix(in srgb, red 10%, transparent)",
    " #000000",
  ])("color value %j is rejected", (v) => {
    expect(errorsOf(dark({ color: { bg: v } })).join("\n")).toMatch(
      /schemes\.dark\.color\.bg: .*#RRGGBB/,
    );
  });

  it("a __proto__ token name is reported, not dropped", () => {
    expect(
      errorsOf(
        JSON.parse(
          '{"name":{"en":"T","zh":"T"},"schemes":{"dark":{"color":{"__proto__":"#000000"}}}}',
        ),
      ).join("\n"),
    ).toMatch(/unknown token color\.__proto__/);
    expect(
      errorsOf(
        '{"name":{"en":"T","zh":"T"},"schemes":{"dark":{"shadow":{"__proto__":"0 0 1px #000000"}}}}',
      ).join("\n"),
    ).toMatch(/unknown token shadow\.__proto__/);
  });

  it("asset paths: every segment of letters, digits, '.', '_' or '-'", () => {
    const withFile = (file: string) => ({
      ...neonGrid(),
      fonts: [{ family: "A", file, weight: 400, role: "prose" }],
    });
    for (const file of [
      "fonts/a');}*{display:none}</style>.woff2",
      'fonts/a".woff2',
      "fonts/a'.woff2",
      "fonts/a(b).woff2",
      "fonts/a{b}.woff2",
      "fonts/<a.woff2",
      "fonts/a b.woff2",
      "fonts/a%20b.woff2",
      "./../a.woff2",
      "fonts/./a.woff2",
    ]) {
      expect(errorsOf(withFile(file)).join("\n"), file).toMatch(/^fonts\.0\.file: /m);
    }
    expect(errorsOf(withFile("./fonts/Mi_Sans-1.2.woff2"))).toEqual([]);
    for (const mark of [
      "./lo go.svg",
      "./logo(1).svg",
      "./<logo.svg",
      "./logo%2e.png",
      "./'.svg",
    ]) {
      expect(errorsOf({ ...neonGrid(), logo: { mark } }).join("\n"), mark).toMatch(
        /^logo\.mark: /m,
      );
      expect(errorsOf({ ...neonGrid(), logo: { favicon: mark } }).join("\n"), mark).toMatch(
        /^logo\.favicon: /m,
      );
    }
  });

  it("free text rejects control, format, separator and lone surrogate characters", () => {
    for (const bad of ["A\u202EB", "A\u0000B", "A\u2028B", "A\u2029B", "A\uD800B"]) {
      expect(errorsOf({ ...neonGrid(), name: { en: bad, zh: "T" } }).join("\n")).toMatch(
        /^name\.en: /m,
      );
      expect(errorsOf({ ...neonGrid(), name: { en: "T", zh: bad } }).join("\n")).toMatch(
        /^name\.zh: /m,
      );
      expect(errorsOf({ ...neonGrid(), description: { en: bad } }).join("\n")).toMatch(
        /^description\.en: /m,
      );
      expect(errorsOf({ ...neonGrid(), description: { en: "x", zh: bad } }).join("\n")).toMatch(
        /^description\.zh: /m,
      );
      expect(errorsOf({ ...neonGrid(), logo: { wordmark: bad } }).join("\n")).toMatch(
        /^logo\.wordmark: /m,
      );
    }
  });

  it("the file size limit holds for an object input too", () => {
    const big = {
      ...neonGrid(),
      description: { en: "x".repeat(1000) },
      pad: "y".repeat(THEME_LIMITS.fileBytes),
    };
    expect(errorsOf(big)[0]).toMatch(/larger than 65536 bytes/);
    const cyclic: Record<string, unknown> = neonGrid();
    cyclic.self = cyclic;
    expect(errorsOf(cyclic)[0]).toMatch(/must be a JSON object/);
  });

  it("normalizes colors: uppercase hex, rgba without spaces", () => {
    const t = parsed(
      dark({ color: { accent: "#fce300", "focus-ring": "rgba( 252, 227, 0, 0.250 )" } }),
    );
    expect(mergeThemeSchemes(t).dark?.color.accent).toBe("#FCE300");
    expect(mergeThemeSchemes(t).dark?.color["focus-ring"]).toBe("rgba(252,227,0,0.25)");
    expect(t.schemes.dark?.color?.["focus-ring"]).toBe("rgba(252,227,0,0.25)");
    expect(
      mergeThemeSchemes(parsed(dark({ color: { scrim: "rgba(0,0,0,1)" } }))).dark?.color.scrim,
    ).toBe("rgba(0,0,0,1)");
  });

  it("parses shadows into parts and re-renders them", () => {
    const t = parsed(
      dark({
        shadow: {
          "shadow-1": "-16px 0 40px rgba(0, 0, 0, .40)",
          "shadow-2": "0px 2px 8px 1px #0a0a0a",
        },
      }),
    );
    expect(mergeThemeSchemes(t).dark?.shadow["shadow-1"]).toBe("-16px 0 40px rgba(0,0,0,0.4)");
    expect(mergeThemeSchemes(t).dark?.shadow["shadow-2"]).toBe("0 2px 8px 1px #0A0A0A");
  });

  it.each([
    "0 0 12px",
    "0 12px rgba(0,0,0,.4)",
    "0 0 12px 1px 2px #000000",
    "inset 0 0 12px #000000",
    "0 0 -12px #000000",
    "0 0 12em #000000",
    "0 0 12 #000000",
    "0 0 12px #000000, 0 0 1px #000000",
    "0 0 12px rgba(0,0,0,.4));}*{",
    "0 0 12px url(x)",
    "0 0 12px var(--x)",
    "0 0 12pxrgba(0,0,0,1)",
  ])("shadow value %j is rejected", (v) => {
    expect(errorsOf(dark({ shadow: { "shadow-1": v } })).join("\n")).toMatch(
      /schemes\.dark\.shadow\.shadow-1: /,
    );
  });

  it("radius: integers 0-16 on sm / md / bubble", () => {
    expect(errorsOf(dark({ radius: { md: 17 } })).join("\n")).toMatch(/schemes\.dark\.radius\.md/);
    expect(errorsOf(dark({ radius: { md: 1.5 } })).join("\n")).toMatch(/schemes\.dark\.radius\.md/);
    expect(errorsOf(dark({ radius: { md: -1 } })).join("\n")).toMatch(/schemes\.dark\.radius\.md/);
    expect(errorsOf(dark({ radius: { lg: 2 } })).join("\n")).toMatch(/lg/);
    expect(mergeThemeSchemes(parsed(dark({ radius: { bubble: 16 } }))).dark?.radius.bubble).toBe(
      16,
    );
  });

  it("font family grammar", () => {
    const font = (family: string) => ({
      ...neonGrid(),
      fonts: [{ family, file: "./fonts/a.woff2", weight: 400, role: "mono" }],
    });
    expect(errorsOf(font("x;}*{")).join("\n")).toMatch(/^fonts\.0\.family: /m);
    expect(errorsOf(font("a'b")).join("\n")).toMatch(/^fonts\.0\.family: /m);
    expect(errorsOf(font("x".repeat(65))).join("\n")).toMatch(/^fonts\.0\.family: /m);
    expect(errorsOf(font("Sarasa Mono SC-2"))).toEqual([]);
  });

  it("font file, weight, style, role and count", () => {
    const withFont = (f: Record<string, unknown>) => ({
      ...neonGrid(),
      fonts: [{ family: "A", file: "./fonts/a.woff2", weight: 400, role: "prose", ...f }],
    });
    expect(errorsOf(withFont({ file: "./fonts/a.ttf" })).join("\n")).toMatch(/fonts\.0\.file/);
    expect(errorsOf(withFont({ file: "../a.woff2" })).join("\n")).toMatch(/fonts\.0\.file/);
    expect(errorsOf(withFont({ file: "/a.woff2" })).join("\n")).toMatch(/fonts\.0\.file/);
    expect(errorsOf(withFont({ weight: 950 })).join("\n")).toMatch(/fonts\.0\.weight/);
    expect(errorsOf(withFont({ style: "oblique" })).join("\n")).toMatch(/fonts\.0\.style/);
    expect(errorsOf(withFont({ role: "display" })).join("\n")).toMatch(/fonts\.0\.role/);
    expect(errorsOf(withFont({ style: "italic", file: "fonts/a-i.woff2" }))).toEqual([]);
    const fonts = Array.from({ length: 9 }, (_, i) => ({
      family: "A",
      file: `./fonts/a${i}.woff2`,
      weight: 100 * (i + 1),
      role: "prose",
    }));
    expect(errorsOf({ ...neonGrid(), fonts }).join("\n")).toMatch(/^fonts: /m);
    expect(errorsOf({ ...neonGrid(), fonts: fonts.slice(0, 8) })).toEqual([]);
    const dup = [fonts[0], { ...fonts[0], file: "./fonts/b.woff2" }];
    expect(errorsOf({ ...neonGrid(), fonts: dup }).join("\n")).toMatch(/duplicate font/);
  });

  it("logo paths and wordmark", () => {
    const logo = (l: Record<string, unknown>) => ({ ...neonGrid(), logo: l });
    expect(errorsOf(logo({ mark: "./logo.gif" })).join("\n")).toMatch(/logo\.mark/);
    expect(errorsOf(logo({ favicon: "../f.png" })).join("\n")).toMatch(/logo\.favicon/);
    expect(errorsOf(logo({ wordmark: "W".repeat(25) })).join("\n")).toMatch(/logo\.wordmark/);
    expect(errorsOf(logo({ wordmark: "A‮B" })).join("\n")).toMatch(/logo\.wordmark/);
    expect(errorsOf(logo({ wordmark: "A\nB" })).join("\n")).toMatch(/logo\.wordmark/);
    expect(errorsOf(logo({ wordmark: " " })).join("\n")).toMatch(/logo\.wordmark/);
    expect(errorsOf(logo({ wordmark: "霓虹网格".repeat(6), favicon: "./f.png" }))).toEqual([]);
    expect(errorsOf(logo({ extra: 1 })).join("\n")).toMatch(/extra/);
  });

  it("accepts a brand-complete theme", () => {
    const t = parsed(brandKit());
    const input = brandKit();
    expect(t.logo).toEqual(input.logo);
    expect(t.decoration).toBe("none");
    expect(t.avatars).toEqual(input.avatars);
    expect(t.hideAvatarPresets).toEqual(["capybara"]);
  });

  it("rejects appIconMaskable without appIcon", () => {
    const e = errorsOf({ ...brandKit(), logo: { appIconMaskable: "./app-mask-512.png" } });
    expect(e).toEqual([expect.stringMatching(/^logo\.appIconMaskable: .*appIcon/)]);
  });

  it("rejects an SVG app icon", () => {
    const e = errorsOf({ ...brandKit(), logo: { appIcon: "./app.svg" } });
    expect(e).toEqual([expect.stringMatching(/^logo\.appIcon: .*\.png/)]);
    const m = errorsOf({
      ...brandKit(),
      logo: { appIcon: "./app.png", appIconMaskable: "./mask.svg" },
    });
    expect(m).toEqual([expect.stringMatching(/^logo\.appIconMaskable: .*\.png/)]);
  });

  it("rejects more than 12 avatars", () => {
    const avatars = Array.from({ length: 13 }, (_, i) => avatar(`a${i}`));
    expect(errorsOf({ ...brandKit(), avatars }).join("\n")).toMatch(/^avatars/m);
    expect(errorsOf({ ...brandKit(), avatars: avatars.slice(0, 12) })).toEqual([]);
  });

  it("rejects a duplicate avatar id", () => {
    const e = errorsOf({ ...brandKit(), avatars: [avatar("bot"), avatar("bot")] });
    expect(e).toEqual([expect.stringMatching(/^avatars\.1\.id: .*duplicate.*bot/)]);
  });

  it("rejects an avatar id that is a built-in id", () => {
    const e = errorsOf({ ...brandKit(), avatars: [avatar("fox")] });
    expect(e).toEqual([expect.stringMatching(/^avatars\.0\.id: .*built-in.*fox/)]);
  });

  it("rejects an avatar id outside the pattern", () => {
    for (const id of ["Bot_1", "-bot", "", "a".repeat(33)]) {
      expect(errorsOf({ ...brandKit(), avatars: [avatar(id)] }).join("\n")).toMatch(
        /^avatars\.0\.id/m,
      );
    }
    expect(errorsOf({ ...brandKit(), avatars: [avatar("a".repeat(32))] })).toEqual([]);
  });

  it("rejects an avatar name over 24 characters", () => {
    const long = errorsOf({
      ...brandKit(),
      avatars: [avatar("bot", { name: { en: "W".repeat(25) } })],
    });
    expect(long).toEqual(["avatars.0.name.en: name.en must be at most 24 characters"]);
    const zh = errorsOf({
      ...brandKit(),
      avatars: [avatar("bot", { name: { en: "Bot", zh: "机".repeat(25) } })],
    });
    expect(zh).toEqual(["avatars.0.name.zh: name.zh must be at most 24 characters"]);
    // 24 characters, counted by code point, is fine
    expect(
      errorsOf({ ...brandKit(), avatars: [avatar("bot", { name: { en: "霓虹网格".repeat(6) } })] }),
    ).toEqual([]);
  });

  it("rejects an avatar name with a forbidden character", () => {
    const wordmark = errorsOf({ ...brandKit(), logo: { wordmark: "A\u202eB" } });
    const name = errorsOf({
      ...brandKit(),
      avatars: [avatar("bot", { name: { en: "A\u202eB" } })],
    });
    const forbidden =
      "must not contain control, format, line / paragraph separator or lone surrogate characters";
    // the wordmark's message, naming the field
    expect(wordmark).toEqual([`logo.wordmark: wordmark ${forbidden}`]);
    expect(name).toEqual([`avatars.0.name.en: name.en ${forbidden}`]);
    expect(errorsOf({ ...brandKit(), avatars: [avatar("bot", { name: { en: " " } })] })).toEqual([
      "avatars.0.name.en: name.en must not be blank",
    ]);
    expect(
      errorsOf({ ...brandKit(), avatars: [avatar("bot", { name: { zh: "x" } })] }).join("\n"),
    ).toMatch(/^avatars\.0\.name\.en/m);
  });

  it("rejects an unknown hidden preset", () => {
    const e = errorsOf({ ...brandKit(), hideAvatarPresets: ["dragon"] });
    expect(e.join("\n")).toMatch(/^hideAvatarPresets\.0/m);
    expect(errorsOf({ ...brandKit(), hideAvatarPresets: ["fox", "owl", "fox"] })).toEqual([
      "hideAvatarPresets.2: duplicate hidden preset fox",
    ]);
  });

  it("rejects hiding all ten built-ins without avatars", () => {
    const all = [...BUILTIN_AVATAR_PRESET_IDS];
    expect(errorsOf({ ...brandKit(), avatars: undefined, hideAvatarPresets: all })).toEqual([
      expect.stringMatching(/^hideAvatarPresets: .*avatars/),
    ]);
    expect(errorsOf({ ...brandKit(), avatars: [], hideAvatarPresets: all })).toHaveLength(1);
    // nine hidden leaves one built-in
    expect(errorsOf({ ...brandKit(), avatars: [], hideAvatarPresets: all.slice(1) })).toEqual([]);
  });

  it("accepts hiding all ten with one avatar", () => {
    const all = [...BUILTIN_AVATAR_PRESET_IDS];
    expect(errorsOf({ ...brandKit(), avatars: [avatar("bot")], hideAvatarPresets: all })).toEqual(
      [],
    );
  });

  it('rejects decoration "stars"', () => {
    expect(errorsOf({ ...brandKit(), decoration: "stars" }).join("\n")).toMatch(/^decoration/m);
    expect(parsed({ ...brandKit(), decoration: "dither" }).decoration).toBe("dither");
  });

  it("decoration omitted parses as undefined", () => {
    const t = parsed(neonGrid());
    expect(t.decoration).toBeUndefined();
    expect(t).not.toHaveProperty("decoration");
  });

  it("built-in avatar preset ids", () => {
    expect(BUILTIN_AVATAR_PRESET_IDS).toEqual([
      "capybara",
      "black-bear",
      "panda",
      "elephant",
      "fox",
      "owl",
      "penguin",
      "rabbit",
      "turtle",
      "whale",
    ]);
  });

  it("an unreadable merged scheme is reported with the failing pair", () => {
    const e = errorsOf(dark({ color: { bg: "#8E8E89" } }));
    expect(e.some((x) => x.startsWith("unreadable:") && x.includes("muted on bg"))).toBe(true);
  });

  it("readability: false (a version already in a catalog) checks grammar and names, not readability", () => {
    const unreadable = dark({ color: { bg: "#8E8E89" } });
    const r = parseThemeFile("t", unreadable, { readability: false });
    expect("errors" in r).toBe(false);
    const bad = parseThemeFile("t", dark({ color: { nope: "#000000", bg: "red" } }), {
      readability: false,
    });
    expect("errors" in bad ? bad.errors.join("\n") : "").toMatch(/unknown token color\.nope/);
    expect("errors" in bad ? bad.errors.join("\n") : "").toMatch(/schemes\.dark\.color\.bg/);
  });

  it("schemes must name dark or light", () => {
    expect(errorsOf({ name: { en: "T", zh: "T" }, schemes: {} }).join("\n")).toMatch(/^schemes/m);
    expect(errorsOf({ name: { en: "T", zh: "T" }, schemes: { dim: {} } }).join("\n")).toMatch(
      /dim/,
    );
  });

  it("shape: name, description, unknown keys", () => {
    expect(errorsOf({ ...neonGrid(), name: { en: "X" } }).join("\n")).toMatch(/^name/m);
    expect(errorsOf({ ...neonGrid(), description: { zh: "x" } }).join("\n")).toMatch(
      /^description/m,
    );
    expect(errorsOf({ ...neonGrid(), extra: 1 }).join("\n")).toMatch(/extra/);
    expect(errorsOf(dark({ font: {} })).join("\n")).toMatch(/font/);
  });

  it("themeIdOf takes the file's base name", () => {
    expect(themeIdOf("themes/neon-grid.json")).toBe("neon-grid");
    expect(themeIdOf("./themes/neon-grid.json")).toBe("neon-grid");
  });

  it("limits", () => {
    expect(THEME_LIMITS).toEqual({
      fileBytes: 65536,
      perPlugin: 10,
      assetsBytes: 16777216,
      fonts: 8,
      fontBytes: 2097152,
      svgBytes: 131072,
      pngBytes: 262144,
      pngMinHeight: 64,
      wordmark: 24,
      avatars: 12,
      appIconBytes: 1048576,
      appIconMinSize: 512,
    });
  });
});

describe("theme.v1 JSON Schema", () => {
  const schema = JSON.parse(
    readFileSync(new URL("../schemas/theme.v1.schema.json", import.meta.url), "utf8"),
  );
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
  it.each([
    ["the spec example", neonGrid()],
    ["the brand-complete example", brandKit()],
    ["unknown key", { ...neonGrid(), extra: 1 }],
    ["unknown key under logo", { ...brandKit(), logo: { appIcon: "./a.png", banner: "./b.png" } }],
    ["unknown key under an avatar", { ...brandKit(), avatars: [avatar("bot", { url: "x" })] }],
    ["an unknown decoration", { ...brandKit(), decoration: "stars" }],
    ["missing name", { ...neonGrid(), name: undefined }],
    ["radius out of range", dark({ radius: { md: 17 } })],
  ])("agrees with zod: %s", (_label, json) => {
    const clean = JSON.parse(JSON.stringify(json));
    expect(validate(clean)).toBe(ThemeFileSchema.safeParse(clean).success);
  });

  it("accepts the brand-complete example and rejects unknown keys under logo", () => {
    expect(validate(brandKit())).toBe(true);
    expect(validate({ ...brandKit(), logo: { mark: "./logo.svg", banner: "./b.png" } })).toBe(
      false,
    );
  });
});

describe("stored value re-validation (themes spec §8)", () => {
  it("canonicalThemeValue accepts the grammar and re-renders it canonically", () => {
    expect(canonicalThemeValue("color", "#fce300")).toBe("#FCE300");
    expect(canonicalThemeValue("color", "rgba(0, 0, 0, 0.40)")).toBe("rgba(0,0,0,0.4)");
    expect(canonicalThemeValue("shadow", "0 8px 24px rgba(0,0,0,.4)")).toBe(
      "0 8px 24px rgba(0,0,0,0.4)",
    );
  });

  it("canonicalThemeValue refuses anything outside the grammar", () => {
    for (const v of ["#000;}x{", "red", "#000000 ", "var(--x)", "url(x)"]) {
      expect(canonicalThemeValue("color", v)).toBeUndefined();
    }
    expect(canonicalThemeValue("shadow", "0 0 0 #000;}")).toBeUndefined();
    expect(canonicalThemeValue("color", 5)).toBeUndefined();
    expect(canonicalThemeValue("color", "#".padEnd(300, "0"))).toBeUndefined();
  });

  it("isThemeFontFamily and isThemeAssetPath", () => {
    expect(isThemeFontFamily("MiSans VF")).toBe(true);
    expect(isThemeFontFamily('MiSans"; }')).toBe(false);
    expect(isThemeFontFamily(3)).toBe(false);
    expect(isThemeAssetPath("./fonts/MiSans.woff2")).toBe(true);
    expect(isThemeAssetPath("fonts/MiSans.woff2")).toBe(true);
    for (const p of ["../x.woff2", "/abs.woff2", "fonts/a b.woff2", 'a").woff2', "a/./b.png"]) {
      expect(isThemeAssetPath(p)).toBe(false);
    }
  });
});

describe("mergeThemeSchemes", () => {
  it("merges only the schemes the theme defines onto the current built-in values", () => {
    const m = mergeThemeSchemes({ schemes: { light: { color: { accent: "#8A3B12" } } } });
    expect(Object.keys(m)).toEqual(["light"]);
    expect(m.light?.color.accent).toBe("#8A3B12");
    expect(m.light?.color.bg).toBe(THEME_TOKENS.color.bg.light);
  });

  it("a stored override the built-in tokens no longer know, or an invalid value, is skipped", () => {
    // as a definition stored before a core release renamed a token reads after it
    const stored = {
      schemes: {
        dark: {
          color: { "renamed-away": "#FFFFFF", accent: "#FCE300", bg: "x;}*{" },
          radius: { md: 99, sm: 3 },
        },
      },
    } as unknown as Parameters<typeof mergeThemeSchemes>[0];
    const m = mergeThemeSchemes(stored).dark;
    expect(m?.color).not.toHaveProperty("renamed-away");
    expect(m?.color.accent).toBe("#FCE300");
    expect(m?.color.bg).toBe(THEME_TOKENS.color.bg.dark);
    expect(m?.radius).toEqual({ ...THEME_TOKENS.radius, sm: 3 });
  });
});
