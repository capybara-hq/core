import { readFileSync } from "node:fs";
import { CAPYBARA_BITMAP } from "@capybara-hq/design";
import { describe, expect, it } from "vitest";

const svg = readFileSync(new URL("../src/app/icon.svg", import.meta.url), "utf8");

describe("the browser tab icon (src/app/icon.svg)", () => {
  it("is the design system's capybara bitmap, centered in 16×16", () => {
    const d = /<path d="([^"]+)"/.exec(svg)?.[1] ?? "";
    const expected: string[] = [];
    CAPYBARA_BITMAP.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        if (row[x] === "X") expected.push(`M${x + 1} ${y + 3}h1v1h-1z`);
      }
    });
    expect(svg).toContain('viewBox="0 0 16 16"');
    expect(d).toBe(expected.join(""));
  });

  it("uses the accent of each theme (tokens.json accent light / dark)", () => {
    const tokens = JSON.parse(
      readFileSync(new URL("../../../docs/design/tokens.json", import.meta.url), "utf8"),
    ) as { color: Record<string, { light: string; dark: string }> };
    const accent = tokens.color.accent;
    expect(accent).toBeDefined();
    expect(svg).toContain(`path{fill:${accent?.light}}`);
    expect(svg).toContain(`@media (prefers-color-scheme:dark){path{fill:${accent?.dark}}}`);
  });
});
