import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Every size a component uses is a step of a spec §2.5 scale (design spec §2.5): type sizes come
// from the `--cb-type-*` variables, and overlay rows / controls from the row and control steps.
const css = (name: string) =>
  readFileSync(resolve(import.meta.dirname, `../src/styles/${name}.css`), "utf8");
const rule = (source: string, selector: string) => {
  const at = source.indexOf(`\n${selector} {`);
  expect(at, `${selector} not found`).toBeGreaterThanOrEqual(0);
  return source.slice(at, source.indexOf("}", at));
};

describe("design styles stay on the scales", () => {
  it.each(["base", "controls", "display", "overlays", "table"])(
    "%s.css writes no literal type-step font size",
    (name) => {
      const literal = css(name).match(/font-size: (11|12|13|15|16|18|20)px;/g) ?? [];
      expect(literal).toEqual([]);
    },
  );
  it("menu items are row.default high (spec §6.7)", () => {
    expect(rule(css("overlays"), ".cb-menu-item")).toContain("height: var(--cb-row-default);");
  });
  it("the command palette's input is a control step", () => {
    expect(rule(css("overlays"), ".cb-palette-input")).toMatch(
      /height: var\(--cb-control-(dense|default|prominent)\);/,
    );
  });
});
