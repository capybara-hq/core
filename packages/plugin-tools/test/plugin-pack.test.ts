import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkPluginPack } from "../src/check/plugin-pack.js";

const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

describe("checkPluginPack", () => {
  it("非字面量动态 import 的插件报 plugin-pack", async () => {
    const f = await checkPluginPack([fixture("plugin-pack-dynamic-import")]);
    expect(f).toHaveLength(1);
    expect(f[0]?.rule).toBe("plugin-pack");
    expect(f[0]?.file).toMatch(/plugin-pack-dynamic-import[/\\]package\.json$/);
    expect(f[0]?.message).toMatch(/non-literal/);
  });

  it("依赖打不进去（无法解析）的插件报 plugin-pack", async () => {
    const f = await checkPluginPack([fixture("plugin-pack-unresolved")]);
    expect(f.map((x) => x.rule)).toEqual(["plugin-pack"]);
    expect(f[0]?.message).toMatch(/capybara-fixture-not-installed/);
  });

  it("reports package.json files entries the plugin package cannot carry", async () => {
    const f = await checkPluginPack([fixture("plugin-pack-dropped")]);
    expect(f.map((x) => x.rule)).toEqual(["plugin-pack-dropped"]);
    expect(f[0]?.message).toContain('"assets"');
  });

  it("leaves no temporary dir in a violating fixture", async () => {
    await checkPluginPack([fixture("plugin-pack-dynamic-import")]);
    expect((await readdir(fixture("plugin-pack-dynamic-import"))).sort()).toEqual([
      ".capybara-plugin",
      "package.json",
      "src",
    ]);
  });

  it("reports a plugin without .capybara-plugin/plugin.json", async () => {
    const f = await checkPluginPack([fixture("plugin-pack-no-manifest")]);
    expect(f.map((x) => x.rule)).toEqual(["plugin-pack"]);
    expect(f[0]?.message).toMatch(/missing \.capybara-plugin\/plugin\.json/);
  });

  it("a well-formed plugin packs into a valid self-contained package", async () => {
    const declarative = fileURLToPath(new URL("./fixtures/declarative", import.meta.url));
    expect(await checkPluginPack([declarative])).toEqual([]);
  }, 60_000);
});
