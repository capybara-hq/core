import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SIZES, TOKEN_NAMES } from "../src/index";

// tokens.css and tokens.ts are generated from docs/design/tokens.json (pnpm gen:tokens); check:tokens
// compares them byte for byte. These tests read the CSS the way a browser would.
const css = readFileSync(resolve(import.meta.dirname, "../src/styles/tokens.css"), "utf8");
type Themed = Record<string, { dark: string; light: string }>;
const json = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../../docs/design/tokens.json"), "utf8"),
) as { color: Themed; shadow: Themed; size: unknown };

function themeTokens(theme: "dark" | "light"): Map<string, string> {
  const m = css.match(new RegExp(`:root\\[data-theme="${theme}"\\]\\s*\\{([^}]*)\\}`));
  if (!m?.[1]) throw new Error(`tokens.css has no ${theme} theme block`);
  const out = new Map<string, string>();
  for (const [, name, value] of m[1].matchAll(/--cb-([a-z0-9-]+):\s*([^;]+);/g)) {
    out.set(name as string, (value as string).trim());
  }
  return out;
}

describe("tokens.css", () => {
  for (const theme of ["dark", "light"] as const) {
    it(`the ${theme} block holds every color and shadow with its tokens.json value`, () => {
      const block = themeTokens(theme);
      const expected = Object.fromEntries(
        Object.entries({ ...json.color, ...json.shadow }).map(([k, v]) => [k, v[theme]]),
      );
      expect(Object.fromEntries(block)).toEqual(expected);
    });
  }

  it("TOKEN_NAMES equals the tokens.json color and shadow keys, in file order", () => {
    expect([...TOKEN_NAMES]).toEqual([...Object.keys(json.color), ...Object.keys(json.shadow)]);
  });

  it("SIZES equals the tokens.json size scales", () => {
    expect(SIZES).toEqual(json.size);
  });

  it("theme-independent variables", () => {
    for (const v of [
      "--cb-font:",
      "--cb-font-prose:",
      "--cb-z-dialog: 50",
      "--cb-motion: 120ms",
      "--cb-control-default: 28px",
      "--cb-layout-sidebar: 256px",
    ]) {
      expect(css).toContain(v);
    }
  });
});
