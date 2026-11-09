import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Client extensions spec §7.2: unlayered CSS beats every cascade layer, so the design stylesheet
// declares the layer order once (design, theme, extensions) and puts every file in `design`; the
// kernel's theme stylesheet goes in `theme` and plugin CSS in `extensions`.

const stylesDir = resolve(import.meta.dirname, "../../../packages/design/src/styles");
const index = readFileSync(resolve(stylesDir, "index.css"), "utf8");

describe("design stylesheet layers", () => {
  it("the design stylesheet declares the layer order first", () => {
    const lines = index.split("\n").filter((l) => l.trim() !== "");
    expect(lines[0]).toBe("@layer design, theme, extensions;");
    const imports = lines.slice(1);
    expect(imports.length).toBeGreaterThan(0);
    for (const line of imports)
      expect(line).toMatch(/^@import "\.\/[a-z0-9-]+\.css" layer\(design\);$/);
    // Every stylesheet of the folder is imported (nothing is left unlayered or unloaded)
    const files = readdirSync(stylesDir).filter((f) => f.endsWith(".css") && f !== "index.css");
    const imported = imports.map((l) => /"\.\/([^"]+)"/.exec(l)?.[1]);
    expect([...imported].sort()).toEqual([...files].sort());
    // fonts.css stays first (its faces before any rule that names them)
    expect(imported[0]).toBe("fonts.css");
  });

  it("no design file declares its own layer or imports another stylesheet", () => {
    for (const f of readdirSync(stylesDir).filter((x) => x.endsWith(".css") && x !== "index.css")) {
      const css = readFileSync(resolve(stylesDir, f), "utf8");
      expect(css, f).not.toMatch(/@layer\b/);
      expect(css, f).not.toMatch(/@import\b/);
    }
  });
});
