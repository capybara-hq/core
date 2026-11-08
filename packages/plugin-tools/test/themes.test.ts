import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { THEME_LIMITS } from "@capybara-hq/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkThemes } from "../src/check/themes.js";

const fixtures = fileURLToPath(new URL("./fixtures", import.meta.url));
const fixture = (name: string) => join(fixtures, name);

const theme = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    name: { en: "T", zh: "T" },
    schemes: { dark: { color: { accent: "#FCE300", "on-accent": "#141200" } } },
    ...extra,
  });

describe("checkThemes", () => {
  it("a clean plugin has no findings", () => {
    expect(checkThemes([fixture("plugin-theme-clean")])).toEqual([]);
  });

  it("an invalid theme file is theme-invalid", () => {
    const f = checkThemes([fixture("plugin-theme-invalid")]);
    expect(f.map((x) => x.rule)).toEqual(["theme-invalid"]);
    expect(f[0]?.file).toMatch(/themes\/broken\.json$/);
    expect(f[0]?.message).toContain("no-such-token");
  });

  it("an unreadable theme is theme-readability", () => {
    const f = checkThemes([fixture("plugin-theme-unreadable")]);
    expect(f.length).toBeGreaterThan(0);
    expect(new Set(f.map((x) => x.rule))).toEqual(new Set(["theme-readability"]));
    expect(f.some((x) => x.message.includes("muted on bg"))).toBe(true);
  });

  it("a bad asset is theme-asset", () => {
    const f = checkThemes([fixture("plugin-theme-asset")]);
    expect(f.map((x) => x.rule)).toEqual(["theme-asset"]);
    expect(f[0]?.message).toContain("bad.woff2");
  });

  describe("generated plugins", () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "theme-check-"));
      await cp(fixture("plugin-theme-clean"), dir, { recursive: true });
    });
    afterEach(() => rm(dir, { recursive: true, force: true }));

    const rules = () => checkThemes([dir]).map((x) => x.rule);

    it("a file that is not JSON is theme-invalid", async () => {
      await writeFile(join(dir, "themes/night-city.json"), "{ nope");
      expect(rules()).toEqual(["theme-invalid"]);
    });

    it("a file over the size limit is theme-invalid", async () => {
      await writeFile(join(dir, "themes/night-city.json"), theme({ pad: "x".repeat(70_000) }));
      expect(rules()).toEqual(["theme-invalid"]);
    });

    it("a theme listed by the manifest but missing is theme-invalid", async () => {
      const file = join(dir, ".capybara-plugin/plugin.json");
      const m = JSON.parse(await readFile(file, "utf8"));
      m.themes = [{ path: "./themes/night-city.json" }, { path: "./themes/gone.json" }];
      await writeFile(file, JSON.stringify(m));
      const f = checkThemes([dir]);
      expect(f.map((x) => x.rule)).toEqual(["theme-invalid"]);
      expect(f[0]?.message).toContain("gone.json");
    });

    it("more themes than the limit are theme-invalid", async () => {
      for (let i = 0; i <= THEME_LIMITS.perPlugin; i++) {
        await writeFile(join(dir, `themes/t${i}.json`), theme());
      }
      expect(rules()).toContain("theme-invalid");
    });

    it("assets summed over the plugin's themes may not exceed the plugin limit", async () => {
      await rm(join(dir, "themes/night-city.json"));
      await mkdir(join(dir, "fonts"), { recursive: true });
      const font = Buffer.concat([Buffer.from("wOF2"), Buffer.alloc(1_500_000)]);
      for (const id of ["a", "b"]) {
        const fonts = [];
        for (let i = 0; i < 8; i++) {
          const file = `./fonts/${id}${i}.woff2`;
          await writeFile(join(dir, file), font);
          fonts.push({ family: `F${id}${i}`, file, weight: 400, role: "prose" });
        }
        await writeFile(join(dir, `themes/${id}.json`), theme({ fonts }));
      }
      // 12 MB per theme passes the per-theme check; 24 MB together does not
      const f = checkThemes([dir]);
      expect(f.map((x) => x.rule)).toEqual(["theme-asset"]);
      expect(f[0]?.message).toContain("plugin");
    });

    it("an asset shared by two themes counts once", async () => {
      await writeFile(
        join(dir, "themes/second.json"),
        await readFile(join(dir, "themes/night-city.json")),
      );
      expect(rules()).toEqual([]);
    });
  });
});
