import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  checkEntryImports,
  defineExtension,
  type ExtensionManifest,
  HOST_PROVIDED_PACKAGES,
  isSafePackagePath,
  type PluginManifest,
  parsePluginManifest,
  type StaticExtensionManifest,
  secret,
  staticManifestOf,
  validatePluginPackageJsonFor,
} from "../src/index.js";

const extensionPlugin = (manifest: StaticExtensionManifest): PluginManifest => {
  const r = parsePluginManifest({
    schemaVersion: 1,
    name: manifest.name,
    version: manifest.version,
    publisher: "Acme",
    description: "A demo plugin",
    extension: { entry: "./dist/index.mjs", manifest },
  });
  if ("errors" in r) throw new Error(r.errors.join("\n"));
  return r;
};

const demo = (): StaticExtensionManifest => ({
  name: "demo-plugin",
  version: "1.2.3",
  sdk: "^0.1.0-rc.0",
  provides: [],
  requires: [],
  optional: [],
  permissions: { tools: ["write"] },
  config: { deployment: [], org: [] },
});

const pkg = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: "@acme/plugin-demo",
  version: "1.2.3",
  type: "module",
  license: "Apache-2.0",
  peerDependencies: { "@capybara-hq/plugin-sdk": "^0.1.0-rc.0", zod: "^4.0.0" },
  ...over,
});

const one = (p: unknown, sdk = "0.1.0") =>
  validatePluginPackageJsonFor(p, extensionPlugin(demo()), sdk).join("\n");

describe("HOST_PROVIDED_PACKAGES", () => {
  it("only the SDK and zod", () => {
    expect([...HOST_PROVIDED_PACKAGES]).toEqual(["@capybara-hq/plugin-sdk", "zod"]);
  });
});

// The rules shared by every plugin package.json (the plugin.json-specific ones are in
// plugin-manifest.test.ts).
describe("validatePluginPackageJsonFor: shared package.json rules", () => {
  it("a valid package.json has no problems", () => {
    expect(one(pkg())).toBe("");
  });

  it("not an object", () => {
    expect(one(null)).toMatch(/must be a JSON object/);
    expect(one([])).toMatch(/must be a JSON object/);
  });

  it.each(["preinstall", "install", "postinstall", "prepare"])(
    "rejects the install script %s",
    (s) => {
      expect(one(pkg({ scripts: { [s]: "node evil.js", test: "vitest" } }))).toMatch(
        new RegExp(`scripts\\.${s}`),
      );
    },
  );

  it("other scripts are allowed (never run at install)", () => {
    expect(one(pkg({ scripts: { test: "vitest" } }))).toBe("");
  });

  it("rejects gypfile", () => {
    expect(one(pkg({ gypfile: true }))).toMatch(/gypfile/);
  });

  it.each(["dependencies", "optionalDependencies", "bundleDependencies", "bundledDependencies"])(
    "rejects %s",
    (f) => {
      const v = f.startsWith("bundle") ? ["lodash"] : { lodash: "^4" };
      expect(one(pkg({ [f]: v }))).toMatch(new RegExp(f));
    },
  );

  it("empty dependencies are allowed", () => {
    expect(one(pkg({ dependencies: {} }))).toBe("");
  });

  it("peerDependencies may only name host packages", () => {
    expect(one(pkg({ peerDependencies: { react: "^19" } }))).toMatch(/peerDependencies.*react/);
  });

  it("name / version", () => {
    expect(one(pkg({ name: "Bad Name" }))).toMatch(/name/);
    expect(one(pkg({ version: "latest" }))).toMatch(/version/);
  });

  it("the host SDK range check uses includePrerelease: a prerelease host satisfies it", () => {
    expect(one(pkg(), "0.1.1-beta.1")).toBe("");
  });

  it("an invalid zod peer range", () => {
    const bad = pkg({
      peerDependencies: { "@capybara-hq/plugin-sdk": "^0.1.0-rc.0", zod: "nope" },
    });
    expect(one(bad)).toMatch(/zod must be a valid semver range/);
  });
});

describe("isSafePackagePath", () => {
  it.each([
    ["dist/index.mjs", true],
    ["migrations/0001_x.sql", true],
    ["../x", false],
    ["a/../b", false],
    ["./a", false],
    ["/a", false],
    ["a//b", false],
    ["a\\b", false],
    ["a\u0000b", false],
    ["a\nb", false],
    ["", false],
    ["C:/x", false],
  ])("%j → %s", (p, ok) => {
    expect(isSafePackagePath(p)).toBe(ok);
  });
});

describe("checkEntryImports", () => {
  const s = (name: string, dynamic = false, literal = true) => ({ name, dynamic, literal });

  it("node:*、宿主两包（含子路径）、包内相对路径放行", () => {
    expect(
      checkEntryImports([
        s("node:fs"),
        s("node:fs/promises"),
        s("zod"),
        s("zod/v4"),
        s("@capybara-hq/plugin-sdk"),
        s("./chunk.mjs"),
        s("../dist/chunk.mjs"),
        s("node:path", true),
      ]),
    ).toEqual([]);
  });

  it("裸三方包被拒（静态与字面量动态都一样）", () => {
    expect(checkEntryImports([s("lodash")]).join()).toMatch(/"lodash".*not allowed/);
    expect(checkEntryImports([s("lodash", true)]).join()).toMatch(/"lodash"/);
  });

  it("不带 node: 前缀的内置模块也被拒（打包工具会改写成 node:）", () => {
    expect(checkEntryImports([s("fs")]).join()).toMatch(/"fs"/);
  });

  it("名字像宿主包但不是", () => {
    expect(checkEntryImports([s("zodiac"), s("@capybara-hq/kernel")])).toHaveLength(2);
  });

  it("非字面量的动态 import 被拒", () => {
    expect(checkEntryImports([s("", true, false)]).join()).toMatch(/non-literal/);
  });
});

describe("staticManifestOf", () => {
  const real = (over: Partial<ExtensionManifest> = {}): ExtensionManifest =>
    defineExtension({
      name: "demo-plugin",
      version: "1.2.3",
      sdk: "^0.1.0-rc.0",
      provides: ["channel@1"],
      requires: [],
      setup() {},
      ...over,
    });

  it("dispose 是函数，不进静态清单（有无 dispose 结果相同）", () => {
    expect(staticManifestOf(real({ dispose() {} }))).toEqual(staticManifestOf(real()));
  });

  it("只保留静态数据，补齐默认值", () => {
    const st = staticManifestOf(real());
    expect(st).toEqual({
      name: "demo-plugin",
      version: "1.2.3",
      sdk: "^0.1.0-rc.0",
      provides: ["channel@1"],
      requires: [],
      optional: [],
      permissions: {},
      config: { deployment: [], org: [] },
    });
    expect(JSON.parse(JSON.stringify(st))).toEqual(st);
  });

  it("配置字段：嵌套对象展开、secret 继承、hot 来自 meta、包装剥掉、按路径排序", () => {
    const st = staticManifestOf(
      real({
        config: {
          deployment: z.object({
            token: secret(z.string()),
            nested: z.object({ b: z.number().default(1), a: z.string().optional() }),
            auth: z.object({ id: z.string(), key: z.string() }).meta({ secret: true }),
            level: z.string().meta({ hot: true }).optional(),
          }),
          org: z.string(),
        },
      }),
    );
    expect(st.config.deployment).toEqual([
      { path: "auth.id", secret: true, hot: false },
      { path: "auth.key", secret: true, hot: false },
      { path: "level", secret: false, hot: true },
      { path: "nested.a", secret: false, hot: false },
      { path: "nested.b", secret: false, hot: false },
      { path: "token", secret: true, hot: false },
    ]);
    expect(st.config.org).toEqual([{ path: "", secret: false, hot: false }]);
  });

  it("权限与界面贡献原样带上（去掉 undefined），函数不进静态清单", () => {
    const st = staticManifestOf(
      real({
        permissions: {
          tools: ["write"],
          http: [{ method: "GET", path: "/ui/a" }],
          ui: { embeds: ["a"] },
        },
        ui: [
          { id: "a", title: { zh: "甲", en: "A" }, place: "page", kind: "embed", path: "/ui/a" },
        ],
        migrations: "../migrations",
      }),
    );
    expect(st.permissions).toEqual({
      tools: ["write"],
      http: [{ method: "GET", path: "/ui/a" }],
      ui: { embeds: ["a"] },
    });
    expect(st.ui).toHaveLength(1);
    expect(Object.keys(st)).not.toContain("migrations");
    expect(Object.keys(st)).not.toContain("setup");
  });

  it("the static manifest passes as plugin.json extension.manifest and the package.json check", () => {
    const st = staticManifestOf(real({ permissions: { secrets: true } }));
    expect(validatePluginPackageJsonFor(pkg(), extensionPlugin(st), "0.1.0")).toEqual([]);
  });
});
