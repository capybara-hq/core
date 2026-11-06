import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Hierarchy comes from size and colour, not weight (spec §2.2): the page title is 600, section,
// card and dialog titles 500, and nothing anywhere is above 600.
const stylesDir = resolve(import.meta.dirname, "../src/styles");
const sheets = readdirSync(stylesDir).filter((f) => f.endsWith(".css") && f !== "fonts.css");
const css = (name: string) => readFileSync(resolve(stylesDir, name), "utf8");
const weightOf = (file: string, selector: string) => {
  const source = css(file);
  const head = selector.endsWith(",") ? selector : `${selector} {`;
  const at = source.indexOf(`\n${head}`);
  expect(at, `${selector} not found in ${file}`).toBeGreaterThanOrEqual(0);
  const body = source.slice(source.indexOf("{", at), source.indexOf("}", at));
  return /font-weight: (\d+);/.exec(body)?.[1];
};

describe("type weights", () => {
  it.each(sheets)("%s sets no font weight above 600", (file) => {
    const heavy = [...css(file).matchAll(/font-weight: (\d+);/g)]
      .map((m) => Number(m[1]))
      .filter((w) => w > 600);
    expect(heavy).toEqual([]);
  });

  it("the page title is 600", () => {
    expect(weightOf("controls.css", '.cb-text[data-variant="h1"]')).toBe("600");
    expect(weightOf("shell.css", ".cb-pageheader-title")).toBe("600");
  });

  it("section, card, dialog and group titles are 500", () => {
    expect(weightOf("controls.css", '.cb-text[data-variant="h2"]')).toBe("500");
    expect(weightOf("controls.css", ".cb-card-head")).toBe("500");
    expect(weightOf("display.css", ".cb-link-card-title")).toBe("500");
    expect(weightOf("overlays.css", ".cb-dialog-title,")).toBe("500");
    expect(weightOf("templates.css", ".cb-danger-zone-title")).toBe("500");
    expect(weightOf("display.css", ".cb-content-section-title")).toBe("500");
    expect(weightOf("sidebar.css", ".cb-sidebar-group-toggle")).toBe("500");
  });
});
