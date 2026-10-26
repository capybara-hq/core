import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const stylesDir = resolve(import.meta.dirname, "../src/styles");
const fontsCss = resolve(stylesDir, "fonts.css");

function faces(): { family: string; weight: string; url: string }[] {
  const css = readFileSync(fontsCss, "utf8");
  return [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map(([, body]) => ({
    family: /font-family:\s*"([^"]+)"/.exec(body as string)?.[1] ?? "",
    weight: /font-weight:\s*(\d+)/.exec(body as string)?.[1] ?? "",
    url: /url\("([^"]+)"\)/.exec(body as string)?.[1] ?? "",
  }));
}

describe("fonts.css", () => {
  it("declares the six faces: Sarasa, Inter and Source Han Sans SC at 400 and 700", () => {
    expect(
      faces()
        .map((f) => `${f.family} ${f.weight}`)
        .sort(),
    ).toEqual([
      "Inter 400",
      "Inter 700",
      "Sarasa Mono SC 400",
      "Sarasa Mono SC 700",
      "Source Han Sans SC 400",
      "Source Han Sans SC 700",
    ]);
  });

  it("every face's file exists, is woff2 and is a subset (under 2.5 MB)", () => {
    for (const f of faces()) {
      const file = resolve(dirname(fontsCss), f.url);
      expect(existsSync(file), f.url).toBe(true);
      expect(f.url).toMatch(/\.subset\.woff2$/);
      expect(statSync(file).size, f.url).toBeLessThan(2.5 * 1024 * 1024);
      expect(readFileSync(file).subarray(0, 4).toString("latin1")).toBe("wOF2");
    }
  });

  it("base.css declares no faces and index.css imports fonts.css first", () => {
    expect(readFileSync(resolve(stylesDir, "base.css"), "utf8")).not.toContain("@font-face");
    const index = readFileSync(resolve(stylesDir, "index.css"), "utf8");
    expect(index.split("\n")[0]).toBe('@import "./fonts.css";');
  });

  it("each font has its license next to it", () => {
    for (const lic of ["OFL.txt", "OFL-Inter.txt", "OFL-SourceHanSans.txt"]) {
      expect(existsSync(resolve(stylesDir, "../fonts", lic)), lic).toBe(true);
    }
  });
});
