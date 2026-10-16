import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkDeps } from "../src/deps.js";

const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
const testing = (name: string) =>
  fileURLToPath(new URL(`../../../packages/testing/test/fixtures/${name}`, import.meta.url));
const sdkSrc = fileURLToPath(new URL("../../../packages/plugin-sdk", import.meta.url));

describe("checkDeps", () => {
  const f = checkDeps([fixture("plugin-imports-kernel")]);
  const inIndex = f.filter((x) => x.file.endsWith("index.ts"));
  const inPkg = f.filter((x) => x.file.endsWith("package.json"));

  it("每一种 import 形态都能抓到（静态、type、export from、export *、动态、require、import 类型）", () => {
    expect(inIndex.every((x) => x.rule === "plugin-imports-kernel")).toBe(true);
    expect(inIndex.map((x) => x.line)).toEqual([2, 3, 7, 8, 10, 11, 12]);
  });

  it("import type 也算", () => {
    expect(inIndex.some((x) => x.line === 3)).toBe(true);
  });

  it("子路径 @capybara-hq/kernel/config 也算", () => {
    expect(inIndex.some((x) => x.message.includes("@capybara-hq/kernel/config"))).toBe(true);
  });

  it("plugin-sdk 与第三方包不报", () => {
    expect(inIndex.some((x) => x.line === 4 || x.line === 5)).toBe(false);
  });

  it("package.json：dependencies / peerDependencies 里的其他 @capybara-hq/* 报，devDependencies 里的 testing 放行", () => {
    const msgs = inPkg.map((x) => x.message).join("\n");
    expect(inPkg.every((x) => x.rule === "plugin-imports-kernel")).toBe(true);
    expect(msgs).toContain("@capybara-hq/kernel");
    expect(msgs).toContain("@capybara-hq/db");
    expect(msgs).toContain("@capybara-hq/checks");
    expect(msgs).not.toContain("中的 @capybara-hq/testing：");
    expect(msgs).not.toContain("中的 @capybara-hq/plugin-sdk：");
    expect(inPkg).toHaveLength(3);
  });

  it("相对路径绕出插件目录 -> plugin-imports-outside", () => {
    const o = f.filter((x) => x.file.endsWith("outside.ts"));
    expect(o.map((x) => x.rule)).toEqual(["plugin-imports-outside"]);
  });

  it("干净的插件 -> 0 条", () => {
    expect(checkDeps([fixture("plugin-clean")])).toEqual([]);
  });

  it("good-counter / whoami -> 0 条", () => {
    expect(checkDeps([testing("good-counter"), testing("whoami")])).toEqual([]);
  });

  it("plugin-sdk 引用任何 @capybara-hq/* -> sdk-imports-internal（源码与 package.json）", () => {
    const s = checkDeps([], [fixture("sdk-imports-internal")]);
    expect(s.map((x) => x.rule)).toEqual(["sdk-imports-internal", "sdk-imports-internal"]);
    expect(s.some((x) => x.file.endsWith("package.json"))).toBe(true);
    expect(s.some((x) => x.file.endsWith("index.ts"))).toBe(true);
  });

  it("真实的 packages/plugin-sdk 是干净的", () => {
    expect(checkDeps([], [sdkSrc])).toEqual([]);
  });
});
