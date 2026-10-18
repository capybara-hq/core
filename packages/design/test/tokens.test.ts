import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { TOKEN_NAMES } from "../src/index";

const css = readFileSync(resolve(import.meta.dirname, "../src/styles/tokens.css"), "utf8");

function themeTokens(theme: "dark" | "light"): Map<string, string> {
  const m = css.match(new RegExp(`:root\\[data-theme="${theme}"\\]\\s*\\{([^}]*)\\}`));
  if (!m?.[1]) throw new Error(`tokens.css 缺少 ${theme} 主题块`);
  const out = new Map<string, string>();
  for (const [, name, value] of m[1].matchAll(/--cb-([a-z0-9-]+):\s*([^;]+);/g)) {
    out.set(name as string, (value as string).trim());
  }
  return out;
}

const dark = themeTokens("dark");
const light = themeTokens("light");

const DARK: Record<string, string> = {
  bg: "#0A0A0A",
  panel: "#121211",
  hover: "#161614",
  line: "#262624",
  "line-strong": "#3A3A37",
  ink: "#E6E6E3",
  muted: "#8E8E89",
  faint: "#5A5A56",
  accent: "#FF6A13",
  "accent-hover": "#FF8240",
  "accent-press": "#E85A08",
  "on-accent": "#0A0A0A",
  "accent-tint": "color-mix(in srgb, var(--cb-accent) 12%, transparent)",
  ok: "#3FD483",
  fail: "#FF5C52",
  warn: "#F2C14B",
  scrim: "rgba(0,0,0,.60)",
  "shadow-1": "0 8px 24px rgba(0,0,0,.40)",
  "shadow-2": "0 16px 48px rgba(0,0,0,.50)",
  "shadow-sheet": "-16px 0 40px rgba(0,0,0,.40)",
};
const LIGHT: Record<string, string> = {
  bg: "#F6F6F3",
  panel: "#FFFFFF",
  hover: "#ECECE7",
  line: "#D6D6D0",
  "line-strong": "#B5B5AE",
  ink: "#0A0A0A",
  muted: "#5E5E5A",
  faint: "#9A9A94",
  accent: "#CC4609",
  "accent-hover": "#B83F08",
  "accent-press": "#A33707",
  "on-accent": "#FFFFFF",
  "accent-tint": "color-mix(in srgb, var(--cb-accent) 12%, transparent)",
  ok: "#16803F",
  fail: "#C8302A",
  warn: "#8F6500",
  scrim: "rgba(10,10,10,.25)",
  "shadow-1": "0 2px 8px rgba(10,10,10,.08)",
  "shadow-2": "0 8px 24px rgba(10,10,10,.12)",
  "shadow-sheet": "-4px 0 16px rgba(10,10,10,.08)",
};

function luminance(hex: string): number {
  const ch = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (ch[0] as number) + 0.7152 * (ch[1] as number) + 0.0722 * (ch[2] as number);
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi as number) + 0.05) / ((lo as number) + 0.05);
}

describe("tokens.css", () => {
  it("两套主题的 token 集合都等于 TOKEN_NAMES", () => {
    const names = [...TOKEN_NAMES].sort();
    expect([...dark.keys()].sort()).toEqual(names);
    expect([...light.keys()].sort()).toEqual(names);
  });

  it("值逐字等于 spec §2.1 / §2.5", () => {
    expect(Object.fromEntries(dark)).toEqual(DARK);
    expect(Object.fromEntries(light)).toEqual(LIGHT);
  });

  it("主题无关变量", () => {
    for (const v of [
      "--cb-font:",
      "--cb-z-sheet: 40",
      "--cb-z-dialog: 50",
      "--cb-z-popover: 60",
      "--cb-z-toast: 70",
      "--cb-motion: 120ms",
    ]) {
      expect(css).toContain(v);
    }
  });

  for (const [name, set] of [
    ["dark", dark],
    ["light", light],
  ] as const) {
    it(`${name} 对比度`, () => {
      const g = (k: string) => set.get(k) as string;
      expect(contrast(g("ink"), g("bg"))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(g("muted"), g("bg"))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(g("on-accent"), g("accent"))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(g("accent"), g("bg"))).toBeGreaterThanOrEqual(3);
    });
  }
});
