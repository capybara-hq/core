import {
  type ParsedTheme,
  parseThemeFile,
  THEME_FONTS,
  THEME_TOKENS,
} from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { renderThemeCss } from "../../src/themes/render-css.js";

/**
 * Themes spec §8 (plan Task 9): the stylesheet is rendered only from the stored, parsed theme, and
 * every stored value is checked again before it reaches CSS.
 */

const parse = (file: Record<string, unknown>): ParsedTheme => {
  const r = parseThemeFile("neon-grid", file);
  if ("errors" in r) throw new Error(r.errors.join("; "));
  return r;
};

const DARK = { bg: "#05070D", panel: "#0A0E18", accent: "#FCE300", "on-accent": "#141200" };

const neonGrid = () =>
  parse({
    name: { en: "Neon Grid", zh: "霓虹网格" },
    schemes: { dark: { color: DARK, radius: { sm: 2 } } },
    fonts: [
      { family: "MiSans", file: "./fonts/MiSans.woff2", weight: 400, role: "prose" },
      { family: "MiSans", file: "./fonts/MiSans-Bold.woff2", weight: 700, role: "prose" },
    ],
  });

const url = (p: string) => `/assets/${encodeURIComponent(p.replace(/^\.\//, ""))}`;

/** The declarations of the rule whose selector is exactly `selector`. */
function block(css: string, selector: string): string | undefined {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) return undefined;
  const start = at + selector.length + 2;
  return css.slice(start, css.indexOf("}", start)).trim();
}

describe("renderThemeCss", () => {
  it("a single-scheme theme writes the same block under both selectors with color-scheme", () => {
    const css = renderThemeCss(neonGrid(), url);
    const dark = block(css, ':root[data-theme="dark"]');
    const light = block(css, ':root[data-theme="light"]');
    expect(dark).toBeDefined();
    expect(light).toBe(dark);
    expect(dark).toContain("color-scheme: dark;");
    expect(dark).toContain("--cb-bg: #05070D;");
    expect(dark).toContain("--cb-accent: #FCE300;");
    expect(dark).toContain("--cb-radius-sm: 2px;");
    // Tokens the theme leaves out keep the theme's own scheme under the other selector too
    expect(dark).toContain(`--cb-ink: ${THEME_TOKENS.color.ink.dark};`);
    expect(dark).toContain(`--cb-shadow-1: ${THEME_TOKENS.shadow["shadow-1"].dark};`);
    expect(dark).toContain(`--cb-avatar-whale: ${THEME_TOKENS.color["avatar-whale"].dark};`);
  });

  it("a two-scheme theme writes each scheme's overrides, without color-scheme", () => {
    const css = renderThemeCss(
      parse({
        name: { en: "Paper", zh: "纸" },
        schemes: { dark: { radius: { sm: 2 } }, light: { color: { accent: "#B33A00" } } },
      }),
      url,
    );
    expect(block(css, ':root[data-theme="dark"]')).toBe("--cb-radius-sm: 2px;");
    expect(block(css, ':root[data-theme="light"]')).toBe("--cb-accent: #B33A00;");
    expect(css).not.toContain("color-scheme");
    expect(css).not.toContain("@font-face");
    expect(css).not.toContain("--cb-font");
  });

  it("fonts: @font-face rules from asset URLs and the families first in their role's stack", () => {
    const css = renderThemeCss(neonGrid(), url);
    expect(css).toContain(
      '@font-face { font-family: "MiSans"; src: url("/assets/fonts%2FMiSans.woff2") format("woff2"); font-weight: 400; font-style: normal; font-display: swap; }',
    );
    expect(css).toContain('url("/assets/fonts%2FMiSans-Bold.woff2")');
    expect(block(css, ":root")).toBe(`--cb-font-prose: "MiSans", ${THEME_FONTS.prose};`);
  });

  it("a mono font goes in front of --cb-font", () => {
    const css = renderThemeCss(
      parse({
        name: { en: "Mono", zh: "等宽" },
        schemes: { light: {} },
        fonts: [{ family: "JetBrains Mono", file: "f/jb.woff2", weight: 400, role: "mono" }],
      }),
      url,
    );
    expect(block(css, ":root")).toBe(`--cb-font: "JetBrains Mono", ${THEME_FONTS.mono};`);
  });

  it("re-validates stored values: tampered values are skipped and reported once", () => {
    const t = neonGrid();
    // A database row changed after parse
    const dark = t.schemes.dark as NonNullable<ParsedTheme["schemes"]["dark"]>;
    (dark.color as Record<string, string>).bg = "#000;}x{";
    (dark.color as Record<string, string>)["ink;}body{x"] = "#FFFFFF";
    (dark.color as Record<string, string>)["avatar-whale"] = "#123456";
    (dark.radius as Record<string, number>).md = 999;
    (dark.radius as Record<string, unknown>).sm = "2px;}";
    const fonts = t.fonts as NonNullable<ParsedTheme["fonts"]>;
    fonts.push(
      { family: 'Evil"; } body { x', file: "./fonts/e.woff2", weight: 400, role: "prose" },
      { family: "Evil", file: '../x").woff2', weight: 400, role: "prose" },
      { family: "Evil", file: "./fonts/e.woff2", weight: 1000, role: "prose" },
      {
        family: "Evil",
        file: "./fonts/e.woff2",
        weight: 400,
        style: "oblique" as "italic",
        role: "prose",
      },
      { family: "Evil", file: "./fonts/e.woff2", weight: 400, role: "bold" as "prose" },
    );
    const reports: string[][] = [];
    const css = renderThemeCss(t, url, (skipped) => reports.push(skipped));
    expect(css).not.toContain("x{");
    expect(css).not.toContain("body");
    expect(css).not.toContain("Evil");
    expect(css).not.toContain("999");
    expect(css).not.toContain("--cb-radius-sm");
    expect(css).not.toContain("#123456");
    // The skipped token falls back to the built-in value of the theme's scheme
    expect(block(css, ':root[data-theme="dark"]')).toContain(
      `--cb-bg: ${THEME_TOKENS.color.bg.dark};`,
    );
    expect(css).toContain("--cb-accent: #FCE300;");
    expect(css).toContain('"MiSans"');
    expect(reports).toHaveLength(1);
    expect(reports[0]).toEqual([
      "schemes.dark.color.bg",
      "schemes.dark.color.ink;}body{x",
      "schemes.dark.color.avatar-whale",
      "schemes.dark.radius.sm",
      "schemes.dark.radius.md",
      "fonts.2",
      "fonts.3",
      "fonts.4",
      "fonts.5",
      "fonts.6",
    ]);
  });

  it("theme css is one @layer theme block", () => {
    // Client extensions spec §7.2: unlayered CSS beats every layer, so the theme sits in the
    // `theme` layer the design stylesheet declares (design, theme, extensions).
    for (const theme of [
      neonGrid(),
      parse({ name: { en: "Empty", zh: "空" }, schemes: { dark: {}, light: {} } }),
    ]) {
      const css = renderThemeCss(theme, url);
      expect(css.startsWith("@layer theme {\n")).toBe(true);
      expect(css.endsWith("\n}\n")).toBe(true);
      expect(css.match(/@layer/g)).toHaveLength(1);
      // Braces balance, and the layer block closes only at the end
      let depth = 0;
      const body = css.slice("@layer theme {".length, -"}\n".length);
      for (const ch of body) {
        if (ch === "{") depth++;
        if (ch === "}") depth--;
        expect(depth).toBeGreaterThanOrEqual(0);
      }
      expect(depth).toBe(0);
    }
    const css = renderThemeCss(neonGrid(), url);
    expect(css).toContain("@font-face {");
    expect(block(css, ':root[data-theme="dark"]')).toContain("--cb-accent: #FCE300;");
  });

  it("reports nothing for a clean theme", () => {
    const reports: string[][] = [];
    renderThemeCss(neonGrid(), url, (s) => reports.push(s));
    expect(reports).toEqual([]);
  });
});
