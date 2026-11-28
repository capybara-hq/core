import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The built-in palette's layering (layered shell spec §1, rule 3): the paper has the most contrast
 * with the text, the ground steps toward the middle, cards on the paper step one level toward the
 * middle too, and what floats is one step lighter than the cards. Built-in values only: themes are
 * held to the readability pairs, not to these steps.
 */
const tokens = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../../docs/design/tokens.json"), "utf8"),
) as { color: Record<string, { dark: string; light: string }> };

const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** OKLab lightness x100 of an opaque #RRGGBB. */
function lightness(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => lin(Number.parseInt(hex.slice(i, i + 2), 16) / 255)) as [
    number,
    number,
    number,
  ];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787046 * b);
  return 100 * (0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s);
}

describe.each(["light", "dark"] as const)("built-in layering, %s", (scheme) => {
  const L = (name: string) => {
    const v = tokens.color[name]?.[scheme];
    if (v === undefined || !/^#[0-9A-F]{6}$/.test(v)) throw new Error(`${name} is not opaque hex`);
    return lightness(v);
  };
  const ink = L("ink");
  const toward = Math.sign(ink - L("bg")); // the direction of the middle, seen from the paper

  it("the card steps from the paper toward the ground, and stands apart from both", () => {
    const bg = L("bg");
    const panel = L("panel");
    const ground = L("sidebar");
    expect((panel - bg) * toward).toBeGreaterThanOrEqual(1.25);
    expect((ground - panel) * toward).toBeGreaterThanOrEqual(2);
  });

  it("panel-2 lies between the paper and the card", () => {
    const bg = L("bg");
    const p2 = L("panel-2");
    const panel = L("panel");
    expect((p2 - bg) * toward).toBeGreaterThan(0);
    expect((panel - p2) * toward).toBeGreaterThan(0);
  });

  it("what floats is lighter than the cards", () => {
    expect(L("raised") - L("panel")).toBeGreaterThanOrEqual(1);
  });
});
