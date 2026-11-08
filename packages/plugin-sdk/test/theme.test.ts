import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  type ParsedTheme,
  parseThemeFile,
  THEME_LIMITS,
  THEME_TOKENS,
  ThemeFileSchema,
  themeIdOf,
} from "../src/index.js";

/** The spec §4 example. */
const nightCity = (): Record<string, unknown> => ({
  name: { en: "Night City", zh: "夜之城" },
  description: { en: "Neon yellow on deep blue-black." },
  schemes: {
    dark: {
      color: { bg: "#05070D", panel: "#0A0E18", accent: "#FCE300", "on-accent": "#141200" },
      shadow: { "shadow-1": "0 0 12px rgba(0,240,255,.25)" },
      radius: { sm: 0, md: 2 },
    },
  },
  fonts: [{ family: "MiSans", file: "./fonts/MiSans-Regular.woff2", weight: 400, role: "prose" }],
  logo: { mark: "./logo.svg", wordmark: "NIGHT CITY" },
});

/** A theme overriding one dark token group. */
const dark = (over: Record<string, unknown>): Record<string, unknown> => ({
  name: { en: "T", zh: "T" },
  schemes: { dark: over },
});

const parsed = (json: unknown, id = "night-city"): ParsedTheme => {
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
    const t = parsed(nightCity());
    expect(t.id).toBe("night-city");
    expect(t.singleScheme).toBe("dark");
    expect(Object.keys(t.merged)).toEqual(["dark"]);
    const m = t.merged.dark;
    expect(m?.color.bg).toBe("#05070D");
    // Tokens the theme leaves out keep the built-in value of that scheme.
    expect(m?.color.ink).toBe(THEME_TOKENS.color.ink.dark);
    expect(m?.color["accent-tint"]).toBe(THEME_TOKENS.color["accent-tint"].dark);
    expect(m?.radius).toEqual({ sm: 0, md: 2, bubble: THEME_TOKENS.radius.bubble });
    // Values are re-rendered from their parsed parts.
    expect(m?.shadow["shadow-1"]).toBe("0 0 12px rgba(0,240,255,0.25)");
    expect(t.schemes.dark?.shadow?.["shadow-1"]).toBe("0 0 12px rgba(0,240,255,0.25)");
    expect(t.fonts?.[0]?.family).toBe("MiSans");
    expect(t.logo?.wordmark).toBe("NIGHT CITY");
  });

  it("both schemes: not single-scheme", () => {
    const t = parsed({ name: { en: "T", zh: "T" }, schemes: { dark: {}, light: {} } });
    expect(t.singleScheme).toBeNull();
    expect(t.merged.light?.color.bg).toBe(THEME_TOKENS.color.bg.light);
  });

  it("accepts the file text, rejects invalid JSON and an oversized file", () => {
    expect(parsed(JSON.stringify(nightCity())).singleScheme).toBe("dark");
    expect(errorsOf("{")[0]).toMatch(/not valid JSON/);
    const big = JSON.stringify({ ...nightCity(), pad: "x".repeat(THEME_LIMITS.fileBytes) });
    expect(errorsOf(big)[0]).toMatch(/larger than 65536 bytes/);
    expect(errorsOf([])[0]).toMatch(/must be a JSON object/);
  });

  it("rejects an invalid id", () => {
    expect(errorsOf(nightCity(), "Night City")[0]).toMatch(/theme id/);
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
      ...nightCity(),
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
      expect(errorsOf({ ...nightCity(), logo: { mark } }).join("\n"), mark).toMatch(
        /^logo\.mark: /m,
      );
      expect(errorsOf({ ...nightCity(), logo: { favicon: mark } }).join("\n"), mark).toMatch(
        /^logo\.favicon: /m,
      );
    }
  });

  it("free text rejects control, format, separator and lone surrogate characters", () => {
    for (const bad of ["A\u202EB", "A\u0000B", "A\u2028B", "A\u2029B", "A\uD800B"]) {
      expect(errorsOf({ ...nightCity(), name: { en: bad, zh: "T" } }).join("\n")).toMatch(
        /^name\.en: /m,
      );
      expect(errorsOf({ ...nightCity(), name: { en: "T", zh: bad } }).join("\n")).toMatch(
        /^name\.zh: /m,
      );
      expect(errorsOf({ ...nightCity(), description: { en: bad } }).join("\n")).toMatch(
        /^description\.en: /m,
      );
      expect(errorsOf({ ...nightCity(), description: { en: "x", zh: bad } }).join("\n")).toMatch(
        /^description\.zh: /m,
      );
      expect(errorsOf({ ...nightCity(), logo: { wordmark: bad } }).join("\n")).toMatch(
        /^logo\.wordmark: /m,
      );
    }
  });

  it("the file size limit holds for an object input too", () => {
    const big = {
      ...nightCity(),
      description: { en: "x".repeat(1000) },
      pad: "y".repeat(THEME_LIMITS.fileBytes),
    };
    expect(errorsOf(big)[0]).toMatch(/larger than 65536 bytes/);
    const cyclic: Record<string, unknown> = nightCity();
    cyclic.self = cyclic;
    expect(errorsOf(cyclic)[0]).toMatch(/must be a JSON object/);
  });

  it("normalizes colors: uppercase hex, rgba without spaces", () => {
    const t = parsed(
      dark({ color: { accent: "#fce300", "focus-ring": "rgba( 252, 227, 0, 0.250 )" } }),
    );
    expect(t.merged.dark?.color.accent).toBe("#FCE300");
    expect(t.merged.dark?.color["focus-ring"]).toBe("rgba(252,227,0,0.25)");
    expect(t.schemes.dark?.color?.["focus-ring"]).toBe("rgba(252,227,0,0.25)");
    expect(parsed(dark({ color: { scrim: "rgba(0,0,0,1)" } })).merged.dark?.color.scrim).toBe(
      "rgba(0,0,0,1)",
    );
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
    expect(t.merged.dark?.shadow["shadow-1"]).toBe("-16px 0 40px rgba(0,0,0,0.4)");
    expect(t.merged.dark?.shadow["shadow-2"]).toBe("0 2px 8px 1px #0A0A0A");
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
    expect(parsed(dark({ radius: { bubble: 16 } })).merged.dark?.radius.bubble).toBe(16);
  });

  it("font family grammar", () => {
    const font = (family: string) => ({
      ...nightCity(),
      fonts: [{ family, file: "./fonts/a.woff2", weight: 400, role: "mono" }],
    });
    expect(errorsOf(font("x;}*{")).join("\n")).toMatch(/^fonts\.0\.family: /m);
    expect(errorsOf(font("a'b")).join("\n")).toMatch(/^fonts\.0\.family: /m);
    expect(errorsOf(font("x".repeat(65))).join("\n")).toMatch(/^fonts\.0\.family: /m);
    expect(errorsOf(font("Sarasa Mono SC-2"))).toEqual([]);
  });

  it("font file, weight, style, role and count", () => {
    const withFont = (f: Record<string, unknown>) => ({
      ...nightCity(),
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
    expect(errorsOf({ ...nightCity(), fonts }).join("\n")).toMatch(/^fonts: /m);
    expect(errorsOf({ ...nightCity(), fonts: fonts.slice(0, 8) })).toEqual([]);
    const dup = [fonts[0], { ...fonts[0], file: "./fonts/b.woff2" }];
    expect(errorsOf({ ...nightCity(), fonts: dup }).join("\n")).toMatch(/duplicate font/);
  });

  it("logo paths and wordmark", () => {
    const logo = (l: Record<string, unknown>) => ({ ...nightCity(), logo: l });
    expect(errorsOf(logo({ mark: "./logo.gif" })).join("\n")).toMatch(/logo\.mark/);
    expect(errorsOf(logo({ favicon: "../f.png" })).join("\n")).toMatch(/logo\.favicon/);
    expect(errorsOf(logo({ wordmark: "W".repeat(25) })).join("\n")).toMatch(/logo\.wordmark/);
    expect(errorsOf(logo({ wordmark: "A‮B" })).join("\n")).toMatch(/logo\.wordmark/);
    expect(errorsOf(logo({ wordmark: "A\nB" })).join("\n")).toMatch(/logo\.wordmark/);
    expect(errorsOf(logo({ wordmark: " " })).join("\n")).toMatch(/logo\.wordmark/);
    expect(errorsOf(logo({ wordmark: "夜之城".repeat(8), favicon: "./f.png" }))).toEqual([]);
    expect(errorsOf(logo({ extra: 1 })).join("\n")).toMatch(/extra/);
  });

  it("an unreadable merged scheme is reported with the failing pair", () => {
    const e = errorsOf(dark({ color: { bg: "#8E8E89" } }));
    expect(e.some((x) => x.startsWith("unreadable:") && x.includes("muted on bg"))).toBe(true);
  });

  it("schemes must name dark or light", () => {
    expect(errorsOf({ name: { en: "T", zh: "T" }, schemes: {} }).join("\n")).toMatch(/^schemes/m);
    expect(errorsOf({ name: { en: "T", zh: "T" }, schemes: { dim: {} } }).join("\n")).toMatch(
      /dim/,
    );
  });

  it("shape: name, description, unknown keys", () => {
    expect(errorsOf({ ...nightCity(), name: { en: "X" } }).join("\n")).toMatch(/^name/m);
    expect(errorsOf({ ...nightCity(), description: { zh: "x" } }).join("\n")).toMatch(
      /^description/m,
    );
    expect(errorsOf({ ...nightCity(), extra: 1 }).join("\n")).toMatch(/extra/);
    expect(errorsOf(dark({ font: {} })).join("\n")).toMatch(/font/);
  });

  it("themeIdOf takes the file's base name", () => {
    expect(themeIdOf("themes/night-city.json")).toBe("night-city");
    expect(themeIdOf("./themes/night-city.json")).toBe("night-city");
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
    });
  });
});

describe("theme.v1 JSON Schema", () => {
  const schema = JSON.parse(
    readFileSync(new URL("../schemas/theme.v1.schema.json", import.meta.url), "utf8"),
  );
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
  it.each([
    ["the spec example", nightCity()],
    ["unknown key", { ...nightCity(), extra: 1 }],
    ["missing name", { ...nightCity(), name: undefined }],
    ["radius out of range", dark({ radius: { md: 17 } })],
  ])("agrees with zod: %s", (_label, json) => {
    const clean = JSON.parse(JSON.stringify(json));
    expect(validate(clean)).toBe(ThemeFileSchema.safeParse(clean).success);
  });
});
