import { describe, expect, it } from "vitest";
import { applyTheme, parseTheme, THEME_COOKIE } from "../src/index";

describe("theme", () => {
  it("parseTheme", () => {
    expect(parseTheme(undefined)).toBe("dark");
    expect(parseTheme("light")).toBe("light");
    expect(parseTheme("dark")).toBe("dark");
    expect(parseTheme("x")).toBe("dark");
  });

  it("applyTheme 设 data-theme 并写 Cookie", () => {
    applyTheme("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(THEME_COOKIE).toBe("cb-theme");
    expect(document.cookie).toContain("cb-theme=light");
    applyTheme("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.cookie).toContain("cb-theme=dark");
  });
});
