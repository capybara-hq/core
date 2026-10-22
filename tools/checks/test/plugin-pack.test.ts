import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkPluginPack } from "../src/plugin-pack.js";

const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
const plugin = (name: string) =>
  fileURLToPath(new URL(`../../../plugins/${name}`, import.meta.url));

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

  it("违规 fixture 不留下临时目录", async () => {
    await checkPluginPack([fixture("plugin-pack-dynamic-import")]);
    expect(await readdir(fixture("plugin-pack-dynamic-import"))).toEqual(["package.json", "src"]);
  });

  it("官方插件能打成能通过内核校验的自包含包", async () => {
    expect(await checkPluginPack([plugin("example-counter"), plugin("todo")])).toEqual([]);
  }, 60_000);
});
