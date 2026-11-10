import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkDeps } from "../src/check/deps.js";
import { bypassFixture } from "./bypass-fixture.js";

const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

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
    expect(msgs).not.toContain("@capybara-hq/testing in ");
    expect(msgs).not.toContain("@capybara-hq/plugin-sdk in ");
    expect(inPkg).toHaveLength(3);
  });

  it("相对路径绕出插件目录 -> plugin-imports-outside", () => {
    const o = f.filter((x) => x.file.endsWith("outside.ts"));
    expect(o.map((x) => x.rule)).toEqual(["plugin-imports-outside"]);
  });

  it("干净的插件 -> 0 条", () => {
    expect(checkDeps([fixture("plugin-clean")])).toEqual([]);
  });

  it("plugin-sdk 引用任何 @capybara-hq/* -> sdk-imports-internal（源码与 package.json）", () => {
    const s = checkDeps([], [fixture("sdk-imports-internal")]);
    expect(s.map((x) => x.rule)).toEqual(["sdk-imports-internal", "sdk-imports-internal"]);
    expect(s.some((x) => x.file.endsWith("package.json"))).toBe(true);
    expect(s.some((x) => x.file.endsWith("index.ts"))).toBe(true);
  });
});

describe("绕过形态", () => {
  const f = checkDeps([fixture("plugin-bypass-deps")]);
  const pkg = f.filter((x) => x.file.endsWith("package.json"));
  const at = (name: string) => f.filter((x) => x.file.endsWith(name));

  it("package.json：别名、optional/bundle 依赖、link 出目录、imports/exports 映射", () => {
    expect(pkg.map((x) => `${x.rule}|${x.message.split(": ")[0]}`).sort()).toEqual(
      [
        "plugin-imports-kernel|kern in dependencies",
        "plugin-imports-kernel|k2 in dependencies",
        "plugin-imports-outside|k3 in dependencies",
        "plugin-imports-kernel|@capybara-hq/kernel in optionalDependencies",
        "plugin-imports-kernel|@capybara-hq/kernel in bundleDependencies",
        "plugin-imports-kernel|#k in imports",
        "plugin-imports-outside|#up in imports",
        "plugin-imports-kernel|./leak in exports",
      ].sort(),
    );
    expect(pkg.every((x) => x.line > 1)).toBe(true);
  });

  it("源码：c.mts 的包名、file: URL、依赖别名、# 子路径（解析 imports 映射）；放行的 #ok", () => {
    expect(at("c.mts").map((x) => [x.line, x.rule])).toEqual([
      [1, "plugin-imports-kernel"],
      [2, "plugin-imports-outside"],
      [3, "plugin-imports-kernel"],
      [4, "plugin-imports-kernel"],
    ]);
  });

  it("源码：import x = require()、字面量拼接的动态 import", () => {
    expect(at("c.cts").map((x) => x.line)).toEqual([1]);
    expect(at("b.cjs").map((x) => x.line)).toEqual([1, 3]);
  });

  it("tests and devDependencies may use @capybara-hq/testing and model-fake; kernel is reported; src/test and src/dist are scanned", () => {
    const fx = bypassFixture();
    try {
      const g = checkDeps([fx.dir]);
      const rel = g.map((x) => x.file.split("plugin-bypass-test-dir/")[1]).sort();
      expect(rel).toEqual(["src/dist/impl.ts", "src/model.ts", "src/test/impl.ts", "test/bad.ts"]);
    } finally {
      fx.cleanup();
    }
  });

  it("sdk：相对路径逃出 plugin-sdk 包目录 -> sdk-imports-internal", () => {
    const s = checkDeps([], [fixture("sdk-escape")]);
    expect(s.map((x) => [x.rule, x.line])).toEqual([["sdk-imports-internal", 2]]);
  });
});

describe("checkDeps and @capybara-hq/plugin-client", () => {
  it("plugin-client passes in package.json and source; kernel and other packages still fail", async () => {
    const { mkdtemp, mkdir, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "deps-client-"));
    try {
      await mkdir(join(dir, "src"));
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({
          name: "x",
          dependencies: {
            "@capybara-hq/plugin-client": "^0.1.0",
            "@capybara-hq/plugin-sdk": "^0.1.0",
            "@capybara-hq/kernel": "^0.1.0",
          },
        }),
      );
      await writeFile(
        join(dir, "src/client.tsx"),
        'import { useAccess } from "@capybara-hq/plugin-client";\nimport { k } from "@capybara-hq/kernel";\nimport { d } from "@capybara-hq/design";\nexport default [useAccess, k, d];\n',
      );
      const f = checkDeps([dir]);
      expect(f.map((x) => `${x.rule}|${x.file.split("/").pop()}|${x.line}`).sort()).toEqual(
        [
          "plugin-imports-kernel|client.tsx|2",
          "plugin-imports-kernel|client.tsx|3",
          "plugin-imports-kernel|package.json|1",
        ].sort(),
      );
      expect(f.some((x) => x.message.includes("plugin-client in"))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
