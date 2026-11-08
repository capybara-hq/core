import { describe, expect, it } from "vitest";
import {
  checkThemeReadability,
  compositeOver,
  contrastRatio,
  type MergedScheme,
  oklabL,
  THEME_OVERRIDABLE,
  THEME_TOKENS,
  type ThemeScheme,
} from "../src/index.js";

const merged = (scheme: ThemeScheme): MergedScheme => ({
  color: Object.fromEntries(Object.entries(THEME_TOKENS.color).map(([n, v]) => [n, v[scheme]])),
  shadow: Object.fromEntries(Object.entries(THEME_TOKENS.shadow).map(([n, v]) => [n, v[scheme]])),
  radius: { ...THEME_TOKENS.radius },
});

describe("checkThemeReadability", () => {
  it("the built-in values pass in both schemes", () => {
    expect(checkThemeReadability("dark", merged("dark"))).toEqual([]);
    expect(checkThemeReadability("light", merged("light"))).toEqual([]);
  });

  it("a mid-gray bg -> a contrast issue for muted on bg", () => {
    const m = merged("dark");
    m.color.bg = "#8E8E89";
    const issues = checkThemeReadability("dark", m);
    const hit = issues.find((i) => i.kind === "contrast" && i.pair === "muted on bg");
    expect(hit).toBeDefined();
    expect(hit?.ratio).toBeLessThan(hit?.floor ?? 0);
  });

  it("a lowercase-hex bg is evaluated, not skipped", () => {
    const m = merged("dark");
    m.color.bg = "#8e8e89";
    const issues = checkThemeReadability("dark", m);
    expect(issues.some((i) => i.kind === "contrast" && i.pair === "muted on bg")).toBe(true);
    const ok = merged("dark");
    ok.color.bg = (ok.color.bg as string).toLowerCase();
    expect(checkThemeReadability("dark", ok)).toEqual([]);
  });

  it("an unevaluable value produces an issue; color-mix does not", () => {
    const m = merged("dark");
    m.color.bg = "tomato";
    m.color.muted = "rgb(1,2,3)";
    const issues = checkThemeReadability("dark", m).filter((i) => i.kind === "unevaluable");
    expect(issues.map((i) => i.pair).sort()).toEqual(["bg", "muted"]);
    expect(merged("dark").color["accent-tint"]).toContain("color-mix(");
  });

  it("hover equal to bg -> a separation issue", () => {
    const m = merged("dark");
    m.color.hover = m.color.bg as string;
    const issues = checkThemeReadability("dark", m);
    expect(issues.some((i) => i.kind === "separation" && i.pair === "hover on bg")).toBe(true);
  });
});

describe("color math", () => {
  it("contrast of black on white is 21", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
  });
  it("OKLab lightness spans 0 to 100", () => {
    expect(oklabL("#000000")).toBeCloseTo(0, 3);
    expect(oklabL("#FFFFFF")).toBeCloseTo(100, 1);
  });
  it("compositeOver blends rgba, passes hex, rejects color-mix", () => {
    expect(compositeOver("#123456", "#FFFFFF")).toBe("#123456");
    expect(compositeOver("rgba(0,0,0,0.5)", "#FFFFFF")).toBe("#808080");
    expect(compositeOver("color-mix(in srgb, red 10%, transparent)", "#FFFFFF")).toBeUndefined();
  });
});

describe("THEME_OVERRIDABLE", () => {
  it("excludes avatar colors and color-mix tokens, keeps shadows and radii", () => {
    expect(THEME_OVERRIDABLE.color).not.toContain("avatar-capybara-ground");
    expect(THEME_OVERRIDABLE.color).not.toContain("accent-tint");
    expect(THEME_OVERRIDABLE.color).toContain("bg");
    expect(THEME_OVERRIDABLE.shadow.length).toBeGreaterThan(0);
    expect(THEME_OVERRIDABLE.radius).toEqual(["sm", "md", "bubble"]);
  });
});
