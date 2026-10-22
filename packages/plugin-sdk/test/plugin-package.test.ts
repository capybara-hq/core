import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type CapybaraPackageSection,
  checkEntryImports,
  definePlugin,
  HOST_PROVIDED_PACKAGES,
  isSafePackagePath,
  type PluginManifest,
  type StaticPluginManifest,
  secret,
  staticManifestOf,
  validatePluginPackageJson,
} from "../src/index.js";

const manifest = (over: Partial<StaticPluginManifest> = {}): StaticPluginManifest => ({
  name: "demo-plugin",
  version: "1.2.3",
  sdk: "^0.1.0",
  provides: [],
  requires: [],
  optional: [],
  permissions: { tools: ["write"] },
  config: { deployment: [], org: [] },
  ...over,
});

const section = (over: Partial<CapybaraPackageSection> = {}): CapybaraPackageSection => ({
  kind: "plugin",
  entry: "dist/index.mjs",
  sdk: "^0.1.0",
  manifest: manifest(),
  ...over,
});

const pkg = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: "@acme/plugin-demo",
  version: "1.2.3",
  type: "module",
  license: "Apache-2.0",
  peerDependencies: { "@capybara-hq/plugin-sdk": "^0.1.0", zod: "^4.0.0" },
  capybara: section(),
  ...over,
});

const one = (p: unknown, sdk = "0.1.0") => validatePluginPackageJson(p, sdk).join("\n");

describe("HOST_PROVIDED_PACKAGES", () => {
  it("只有 SDK 与 zod", () => {
    expect([...HOST_PROVIDED_PACKAGES]).toEqual(["@capybara-hq/plugin-sdk", "zod"]);
  });
});

describe("validatePluginPackageJson", () => {
  it("合法的 package.json 没有问题", () => {
    expect(validatePluginPackageJson(pkg(), "0.1.0")).toEqual([]);
  });

  it("可选的 migrations / ui 目录（相对包根）", () => {
    expect(
      validatePluginPackageJson(
        pkg({ capybara: section({ migrations: "migrations", ui: "ui" }) }),
        "0.1.0",
      ),
    ).toEqual([]);
  });

  it("不是对象", () => {
    expect(one(null)).toMatch(/must be a JSON object/);
    expect(one([])).toMatch(/must be a JSON object/);
  });

  it.each(["preinstall", "install", "postinstall", "prepare"])("拒绝安装脚本 %s", (s) => {
    expect(one(pkg({ scripts: { [s]: "node evil.js", test: "vitest" } }))).toMatch(
      new RegExp(`scripts\\.${s}`),
    );
  });

  it("其他脚本不拒绝（安装时不会执行）", () => {
    expect(one(pkg({ scripts: { test: "vitest" } }))).toBe("");
  });

  it("拒绝 gypfile", () => {
    expect(one(pkg({ gypfile: true }))).toMatch(/gypfile/);
  });

  it.each(["dependencies", "optionalDependencies", "bundleDependencies", "bundledDependencies"])(
    "拒绝 %s",
    (f) => {
      const v = f.startsWith("bundle") ? ["lodash"] : { lodash: "^4" };
      expect(one(pkg({ [f]: v }))).toMatch(new RegExp(f));
    },
  );

  it("空的 dependencies 放行", () => {
    expect(one(pkg({ dependencies: {} }))).toBe("");
  });

  it("peerDependencies 只能是宿主提供的包", () => {
    expect(one(pkg({ peerDependencies: { react: "^19" } }))).toMatch(/peerDependencies.*react/);
  });

  it("name / version", () => {
    expect(one(pkg({ name: "Bad Name" }))).toMatch(/name/);
    expect(one(pkg({ version: "latest" }))).toMatch(/version/);
  });

  it("缺 capybara 段或 kind 不对", () => {
    expect(one(pkg({ capybara: undefined }))).toMatch(/capybara/);
    expect(one(pkg({ capybara: section({ kind: "skill" as "plugin" }) }))).toMatch(/kind/);
  });

  it("capybara 段的未知字段", () => {
    expect(one(pkg({ capybara: { ...section(), extra: 1 } }))).toMatch(/extra/);
  });

  it("SDK 范围不满足宿主", () => {
    const s = section({ sdk: "^0.2.0", manifest: manifest({ sdk: "^0.2.0" }) });
    expect(one(pkg({ capybara: s }))).toMatch(/not satisfied.*0\.1\.0/);
  });

  it("SDK 范围按 includePrerelease 判断：宿主是预发布版也能满足", () => {
    expect(one(pkg(), "0.1.1-beta.1")).toBe("");
  });

  it.each(["*", ">=0.1.0", ">0.0.1", "0.x || >=1.0.0", "x"])("拒绝没有上界的 SDK 范围 %s", (r) => {
    const s = section({ sdk: r, manifest: manifest({ sdk: r }) });
    const p = pkg({ capybara: s, peerDependencies: { "@capybara-hq/plugin-sdk": r } });
    expect(one(p)).toMatch(/upper bound/);
  });

  it("有上界的范围放行（^、~、x 范围、区间）", () => {
    for (const r of ["^0.1.0", "~0.1.0", "0.x", ">=0.1.0 <0.2.0", "0.1.0"]) {
      const s = section({ sdk: r, manifest: manifest({ sdk: r }) });
      const p = pkg({ capybara: s, peerDependencies: { "@capybara-hq/plugin-sdk": r } });
      expect(one(p), r).toBe("");
    }
  });

  it("peerDependencies 的 SDK 范围必须存在且等于 capybara.sdk", () => {
    expect(one(pkg({ peerDependencies: { zod: "^4.0.0" } }))).toMatch(
      /peerDependencies "@capybara-hq\/plugin-sdk"/,
    );
    expect(
      one(pkg({ peerDependencies: { "@capybara-hq/plugin-sdk": "^0.1.1", zod: "^4.0.0" } })),
    ).toMatch(/must equal capybara\.sdk/);
  });

  it("peerDependencies.zod 必须被宿主的 zod 满足（给了宿主版本时）", () => {
    const p = pkg({ peerDependencies: { "@capybara-hq/plugin-sdk": "^0.1.0", zod: "^3.22.0" } });
    expect(validatePluginPackageJson(p, "0.1.0", { hostZodVersion: "4.6.7" }).join("\n")).toMatch(
      /zod "\^3\.22\.0" is not satisfied by the host zod 4\.6\.7/,
    );
    expect(validatePluginPackageJson(pkg(), "0.1.0", { hostZodVersion: "4.6.7" })).toEqual([]);
    const bad = pkg({ peerDependencies: { "@capybara-hq/plugin-sdk": "^0.1.0", zod: "nope" } });
    expect(validatePluginPackageJson(bad, "0.1.0", { hostZodVersion: "4.6.7" }).join()).toMatch(
      /zod must be a valid semver range/,
    );
  });

  it("SDK 范围不合法", () => {
    expect(one(pkg({ capybara: section({ sdk: "not a range" }) }))).toMatch(/sdk/);
  });

  it("manifest.sdk 与 capybara.sdk 不一致", () => {
    expect(one(pkg({ capybara: section({ manifest: manifest({ sdk: ">=0.1.0" }) }) }))).toMatch(
      /manifest\.sdk/,
    );
  });

  it("manifest 版本与 package.json 不一致", () => {
    expect(one(pkg({ version: "1.2.4" }))).toMatch(/does not match package\.json version/);
  });

  it("entry 必须是包内的 .mjs 相对路径", () => {
    expect(one(pkg({ capybara: section({ entry: "../evil.mjs" }) }))).toMatch(/entry/);
    expect(one(pkg({ capybara: section({ entry: "/abs/index.mjs" }) }))).toMatch(/entry/);
    expect(one(pkg({ capybara: section({ entry: "dist/index.cjs" }) }))).toMatch(/entry/);
  });

  it("migrations / ui 路径越界", () => {
    expect(one(pkg({ capybara: section({ migrations: "../x" }) }))).toMatch(/migrations/);
    expect(one(pkg({ capybara: section({ ui: "a\\b" }) }))).toMatch(/ui/);
  });

  it("manifest 的内容按 definePlugin 规则校验（能力、权限、界面）", () => {
    expect(
      one(pkg({ capybara: section({ manifest: manifest({ provides: ["nope@1"] }) }) })),
    ).toMatch(/nope/);
    expect(
      one(
        pkg({
          capybara: section({ manifest: manifest({ permissions: { bogus: true } as never }) }),
        }),
      ),
    ).toMatch(/bogus/);
    expect(one(pkg({ capybara: section({ manifest: manifest({ name: "kernel" }) }) }))).toMatch(
      /reserved/,
    );
  });

  it("manifest 的未知字段与配置字段格式", () => {
    expect(
      one(pkg({ capybara: section({ manifest: { ...manifest(), setup: "x" } as never }) })),
    ).toMatch(/setup/);
    const badCfg = manifest({
      config: { deployment: [{ path: "a", secret: "yes" } as never], org: [] },
    });
    expect(one(pkg({ capybara: section({ manifest: badCfg }) }))).toMatch(/config\.deployment/);
    const dupCfg = manifest({
      config: {
        deployment: [],
        org: [
          { path: "a", secret: false, hot: false },
          { path: "a", secret: true, hot: false },
        ],
      },
    });
    expect(one(pkg({ capybara: section({ manifest: dupCfg }) }))).toMatch(/duplicate/);
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
  const real = (over: Partial<PluginManifest> = {}): PluginManifest =>
    definePlugin({
      name: "demo-plugin",
      version: "1.2.3",
      sdk: "^0.1.0",
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
      sdk: "^0.1.0",
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

  it("静态清单能通过 package.json 校验", () => {
    const st = staticManifestOf(real({ permissions: { secrets: true } }));
    expect(
      validatePluginPackageJson(pkg({ capybara: section({ manifest: st }) }), "0.1.0"),
    ).toEqual([]);
  });
});
