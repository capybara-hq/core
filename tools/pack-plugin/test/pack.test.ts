import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  computePermissionSet,
  permissionKeys,
  permissionSetOfPackage,
  readPluginPackage,
} from "@capybara-hq/kernel";
import { type PluginManifest, SDK_VERSION } from "@capybara-hq/plugin-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { packPlugin } from "../src/index.js";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const plugin = (name: string) => join(repo, "plugins", name);
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const OPTS = { maxBytes: 50 * 1024 * 1024, hostSdkVersion: SDK_VERSION };

let out: string;
beforeAll(async () => {
  out = await mkdtemp(join(tmpdir(), "pack-plugin-"));
});
afterAll(async () => {
  await rm(out, { recursive: true, force: true });
});

const realManifest = async (name: string) =>
  ((await import(join(plugin(name), "src/index.ts"))) as { default: PluginManifest }).default;

describe.each(["todo", "slack"])("packPlugin(plugins/%s)", (name) => {
  let result: Awaited<ReturnType<typeof packPlugin>>;
  let bytes: Uint8Array;
  beforeAll(async () => {
    result = await packPlugin(plugin(name), out);
    bytes = new Uint8Array(await readFile(result.file));
  }, 60_000);

  it("产出 npm 风格命名的 tgz，sha256 与文件一致", () => {
    expect(basename(result.file)).toBe(`capybara-hq-plugin-${name}-0.1.0.tgz`);
    expect(result.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(result.manifest.name).toBe(name);
  });

  it("能通过内核校验，package.json 只保留规定字段", async () => {
    const p = await readPluginPackage(bytes, OPTS);
    expect(Object.keys(p.packageJson).sort()).toEqual(
      ["capybara", "license", "name", "peerDependencies", "type", "version"].sort(),
    );
    expect(p.packageJson.name).toBe(`@capybara-hq/plugin-${name}`);
    expect(Object.keys(p.packageJson.peerDependencies as object).sort()).toEqual([
      "@capybara-hq/plugin-sdk",
      "zod",
    ]);
    expect(p.section.entry).toBe("dist/index.mjs");
    expect(p.section.manifest).toEqual(result.manifest);
    const paths = p.files.map((f) => f.path);
    expect(paths).toContain("dist/index.mjs");
    expect(paths.some((x) => x.includes("node_modules"))).toBe(false);
  });

  it("permissionSetOfPackage 与 computePermissionSet(真实模块) 的键完全相等", async () => {
    const p = await readPluginPackage(bytes, OPTS);
    const real = await realManifest(name);
    const expected = permissionKeys(await computePermissionSet(real, join(plugin(name), "src")));
    expect(permissionKeys(permissionSetOfPackage(p))).toEqual(expected);
  });

  it("不在插件目录里留下临时文件", async () => {
    expect((await readdir(plugin(name))).filter((f) => f.startsWith(".capybara-pack"))).toEqual([]);
  });
});

describe("packPlugin 的其他行为", () => {
  it("todo：迁移随包带上，capybara.migrations 指向 migrations", async () => {
    const r = await packPlugin(plugin("todo"), out);
    const p = await readPluginPackage(new Uint8Array(await readFile(r.file)), OPTS);
    expect(p.section.migrations).toBe("migrations");
    expect(p.migrationSql.length).toBeGreaterThan(0);
    expect(permissionKeys(permissionSetOfPackage(p))).toContain("table:todos");
  }, 60_000);

  it("同样的输入产出字节相同的包（可复现）", async () => {
    const a = await packPlugin(plugin("todo"), join(out, "a"));
    const b = await packPlugin(plugin("todo"), join(out, "b"));
    expect(a.sha256).toBe(b.sha256);
  }, 60_000);

  it("打包过程中插件源码树里从不出现临时目录（临时目录在系统临时目录下）", async () => {
    let done = false;
    const seen = new Set<string>();
    const watch = (async () => {
      while (!done) {
        for (const f of await readdir(plugin("todo"))) {
          if (f.startsWith(".capybara-pack")) seen.add(f);
        }
        await new Promise((r) => setImmediate(r));
      }
    })();
    try {
      await packPlugin(plugin("todo"), join(out, "watch"));
    } finally {
      done = true;
      await watch;
    }
    expect([...seen]).toEqual([]);
  }, 60_000);

  it("非字面量动态 import 的插件打包失败", async () => {
    await expect(packPlugin(fixture("dynamic-import"), out)).rejects.toThrow(/non-literal/);
    expect((await readdir(fixture("dynamic-import"))).sort()).toEqual(["package.json", "src"]);
  });

  it("清单版本与 package.json 不一致时打包失败", async () => {
    await expect(packPlugin(fixture("version-mismatch"), out)).rejects.toThrow(
      /version.*0\.1\.0.*0\.2\.0/,
    );
  });
});
