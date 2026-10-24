import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  type CapybaraPackageSection,
  defineExtension,
  SDK_VERSION,
  type StaticExtensionManifest,
  secret,
  staticManifestOf,
} from "@capybara-hq/plugin-sdk";
import { pack as tarPack } from "tar-stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  extractPluginPackage,
  PluginPackageError,
  permissionSetOfPackage,
  readPluginPackage,
} from "../../src/plugins/package.js";
import { computePermissionSet, permissionKeys } from "../../src/plugins/permission-set.js";

type Entry = {
  name: string;
  data?: string | Buffer;
  type?: "file" | "directory" | "symlink" | "link" | "fifo";
  linkname?: string;
};

/** 用 tar-stream 拼一个 gzip 后的 tar（不做任何校验，专门构造恶意包）。 */
async function tgz(entries: Entry[]): Promise<Uint8Array> {
  const p = tarPack();
  const chunks: Buffer[] = [];
  const done = (async () => {
    for await (const c of p) chunks.push(c as Buffer);
  })();
  for (const e of entries) {
    const data = e.data === undefined ? Buffer.alloc(0) : Buffer.from(e.data);
    const type = e.type ?? "file";
    await new Promise<void>((res, rej) =>
      p.entry(
        {
          name: e.name,
          type,
          mode: type === "directory" ? 0o755 : 0o644,
          ...(e.linkname === undefined ? {} : { linkname: e.linkname }),
          ...(type === "file" ? { size: data.length } : {}),
        },
        type === "file" ? data : Buffer.alloc(0),
        (err) => (err ? rej(err) : res()),
      ),
    );
  }
  p.finalize();
  await done;
  return new Uint8Array(gzipSync(Buffer.concat(chunks)));
}

const manifest = (over: Partial<StaticExtensionManifest> = {}): StaticExtensionManifest => ({
  name: "demo",
  version: "1.0.0",
  sdk: "^0.1.0",
  provides: [],
  requires: [],
  optional: [],
  permissions: { tools: ["write"] },
  config: { deployment: [], org: [{ path: "apiKey", secret: true, hot: false }] },
  ...over,
});

const section = (over: Partial<CapybaraPackageSection> = {}): CapybaraPackageSection => ({
  kind: "plugin",
  entry: "dist/index.mjs",
  sdk: "^0.1.0",
  manifest: manifest(),
  ...over,
});

const pkgJson = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    name: "@acme/plugin-demo",
    version: "1.0.0",
    type: "module",
    peerDependencies: { "@capybara-hq/plugin-sdk": "^0.1.0", zod: "^4.0.0" },
    capybara: section(),
    ...over,
  });

const ENTRY = [
  'import { readFile } from "node:fs/promises";',
  'import { z } from "zod";',
  'import { defineExtension } from "@capybara-hq/plugin-sdk";',
  "const meta = import.meta.url;",
  'export default defineExtension({ async setup() { await import("node:path"); } });',
].join("\n");

const base = (over: { pkg?: string; entry?: string; extra?: Entry[] } = {}): Entry[] => [
  { name: "package/package.json", data: over.pkg ?? pkgJson() },
  { name: "package/dist/index.mjs", data: over.entry ?? ENTRY },
  ...(over.extra ?? []),
];

const OPTS = { maxBytes: 10 * 1024 * 1024, hostSdkVersion: SDK_VERSION };

async function rejects(bytes: Uint8Array, re: RegExp, opts = OPTS): Promise<string[]> {
  const err = await readPluginPackage(bytes, opts).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(PluginPackageError);
  const issues = (err as PluginPackageError).issues;
  expect(issues.join("\n")).toMatch(re);
  return issues;
}

describe("readPluginPackage：合法包", () => {
  it("返回 sha256、大小、package.json、文件清单与迁移 SQL", async () => {
    const bytes = await tgz(
      base({
        pkg: pkgJson({ capybara: section({ migrations: "migrations", ui: "ui" }) }),
        extra: [
          { name: "package/migrations/", type: "directory" },
          {
            name: "package/migrations/0001_init.sql",
            data: "CREATE TABLE IF NOT EXISTS a (x int);",
          },
          { name: "package/migrations/README.md", data: "not a migration" },
          { name: "package/ui/index.html", data: "<p>hi</p>" },
        ],
      }),
    );
    const p = await readPluginPackage(bytes, OPTS);
    expect(p.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(p.size).toBe(bytes.byteLength);
    expect(p.packageJson.name).toBe("@acme/plugin-demo");
    expect(p.section.manifest.name).toBe("demo");
    expect(p.files.map((f) => f.path).sort()).toEqual([
      "dist/index.mjs",
      "migrations/0001_init.sql",
      "migrations/README.md",
      "package.json",
      "ui/index.html",
    ]);
    expect(p.migrationSql).toEqual([
      { file: "0001_init.sql", sql: "CREATE TABLE IF NOT EXISTS a (x int);" },
    ]);
  });

  it("包内相对 import 指向的模块也要扫描", async () => {
    const ok = await tgz(
      base({
        entry: 'import "./chunk.mjs"; export default {};',
        extra: [{ name: "package/dist/chunk.mjs", data: 'import "node:os";' }],
      }),
    );
    await expect(readPluginPackage(ok, OPTS)).resolves.toBeDefined();
    const bad = await tgz(
      base({
        entry: 'import "./chunk.mjs"; export default {};',
        extra: [{ name: "package/dist/chunk.mjs", data: 'import "lodash";' }],
      }),
    );
    await rejects(bad, /dist\/chunk\.mjs.*"lodash"/);
  });
});

describe("readPluginPackage：违规包", () => {
  it("有 postinstall", async () => {
    await rejects(
      await tgz(base({ pkg: pkgJson({ scripts: { postinstall: "node x.js" } }) })),
      /scripts\.postinstall/,
    );
  });

  it("有 dependencies", async () => {
    await rejects(
      await tgz(base({ pkg: pkgJson({ dependencies: { lodash: "^4" } }) })),
      /dependencies/,
    );
  });

  it("带 *.node", async () => {
    await rejects(
      await tgz(base({ extra: [{ name: "package/build/Release/addon.node", data: "x" }] })),
      /native addon/,
    );
  });

  it("带 binding.gyp", async () => {
    await rejects(
      await tgz(base({ extra: [{ name: "package/binding.gyp", data: "{}" }] })),
      /binding\.gyp/,
    );
  });

  it("带 node_modules/", async () => {
    await rejects(
      await tgz(base({ extra: [{ name: "package/node_modules/x/index.js", data: "" }] })),
      /node_modules/,
    );
  });

  it("裸 import lodash", async () => {
    await rejects(
      await tgz(base({ entry: 'import _ from "lodash"; export default {};' })),
      /"lodash".*not allowed/,
    );
  });

  it("export from 也算", async () => {
    await rejects(await tgz(base({ entry: 'export * from "left-pad";' })), /"left-pad"/);
  });

  it("非字面量的动态 import", async () => {
    await rejects(
      await tgz(base({ entry: "const n = 'x'; await import(n); export default {};" })),
      /non-literal/,
    );
  });

  it("相对 import 越出包外", async () => {
    await rejects(
      await tgz(base({ entry: 'import "../../../etc/x.mjs"; export default {};' })),
      /outside the package/,
    );
  });

  it("相对 import 指向不存在的文件", async () => {
    await rejects(
      await tgz(base({ entry: 'import "./missing.mjs"; export default {};' })),
      /missing\.mjs.*not found/,
    );
  });

  it("entry 不是合法的 ES 模块", async () => {
    await rejects(await tgz(base({ entry: "import {" })), /not valid ES module/);
  });

  it("SDK 范围不满足", async () => {
    const s = section({ sdk: "^9.0.0", manifest: manifest({ sdk: "^9.0.0" }) });
    await rejects(await tgz(base({ pkg: pkgJson({ capybara: s }) })), /not satisfied/);
  });

  it("peerDependencies.zod 不被宿主的 zod 满足（默认取内核自己的 zod 版本）", async () => {
    const pkg = pkgJson({
      peerDependencies: { "@capybara-hq/plugin-sdk": "^0.1.0", zod: "^3.0.0" },
    });
    await rejects(await tgz(base({ pkg })), /zod "\^3\.0\.0" is not satisfied by the host zod 4\./);
  });

  it("版本不一致", async () => {
    await rejects(
      await tgz(base({ pkg: pkgJson({ version: "1.0.1" }) })),
      /does not match package\.json version/,
    );
  });

  it("路径越界（..）", async () => {
    await rejects(
      await tgz(base({ extra: [{ name: "package/../../evil.sh", data: "x" }] })),
      /unsafe path/,
    );
  });

  it("绝对路径", async () => {
    await rejects(await tgz(base({ extra: [{ name: "/etc/passwd", data: "x" }] })), /package\//);
  });

  it("不在 package/ 下", async () => {
    await rejects(await tgz(base({ extra: [{ name: "other/x.js", data: "x" }] })), /package\//);
  });

  it("符号链接", async () => {
    await rejects(
      await tgz(base({ extra: [{ name: "package/link", type: "symlink", linkname: "/etc" }] })),
      /symlink/,
    );
  });

  it("硬链接", async () => {
    await rejects(
      await tgz(
        base({ extra: [{ name: "package/hard", type: "link", linkname: "package/package.json" }] }),
      ),
      /link/,
    );
  });

  it("其他特殊文件（fifo）", async () => {
    await rejects(await tgz(base({ extra: [{ name: "package/f", type: "fifo" }] })), /fifo/);
  });

  it("重复路径（含大小写不同）", async () => {
    await rejects(
      await tgz(base({ extra: [{ name: "package/DIST/index.mjs", data: "x" }] })),
      /duplicate/,
    );
  });

  it("超过大小（压缩后）", async () => {
    const bytes = await tgz(base());
    await rejects(bytes, /larger than/, { ...OPTS, maxBytes: bytes.byteLength - 1 });
  });

  it("解压后超过上限（压缩炸弹）", async () => {
    const bytes = await tgz(
      base({ extra: [{ name: "package/zeros.bin", data: Buffer.alloc(4 * 1024 * 1024) }] }),
    );
    expect(bytes.byteLength).toBeLessThan(64 * 1024);
    await rejects(bytes, /unpacked/, { ...OPTS, maxUnpackedBytes: 1024 * 1024 } as typeof OPTS);
  });

  it("条目数超过上限", async () => {
    const extra = Array.from({ length: 20 }, (_, i) => ({ name: `package/f${i}.txt`, data: "x" }));
    await rejects(await tgz(base({ extra })), /entries/, {
      ...OPTS,
      maxEntries: 10,
    } as typeof OPTS);
  });

  it("不是 gzip", async () => {
    await rejects(new TextEncoder().encode("hello"), /gzip/);
  });

  it("缺 package.json", async () => {
    await rejects(await tgz([{ name: "package/dist/index.mjs", data: ENTRY }]), /package\.json/);
  });

  it("package.json 不是合法 JSON", async () => {
    await rejects(await tgz(base({ pkg: "{nope" })), /not valid JSON/);
  });

  it("package.json 过大", async () => {
    const big = pkgJson({ description: "x".repeat(2 * 1024 * 1024) });
    await rejects(await tgz(base({ pkg: big })), /package\.json is larger/);
  });

  it("entry 不存在", async () => {
    await rejects(
      await tgz([{ name: "package/package.json", data: pkgJson() }]),
      /entry dist\/index\.mjs.*not found/,
    );
  });

  it("声明了 migrations 却没有这个目录", async () => {
    await rejects(
      await tgz(base({ pkg: pkgJson({ capybara: section({ migrations: "migrations" }) }) })),
      /migrations/,
    );
  });
});

describe("permissionSetOfPackage", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "pkg-perm-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("与 computePermissionSet(真实模块) 的键相等", async () => {
    const real = defineExtension({
      name: "demo",
      version: "1.0.0",
      sdk: "^0.1.0",
      provides: [],
      optional: ["channel@1"],
      migrations: "migrations",
      permissions: { tools: ["write"], secrets: true, http: [{ method: "POST", path: "/x" }] },
      config: {
        deployment: z.object({ url: z.string(), nested: z.object({ k: secret(z.string()) }) }),
        org: z.object({ apiKey: secret(z.string()) }),
      },
      setup() {},
    });
    const sql = "CREATE TABLE IF NOT EXISTS plugin_demo.items (id int);\nCREATE TABLE b (x int);";
    await mkdir(join(dir, "migrations"));
    await writeFile(join(dir, "migrations", "0001_init.sql"), sql);
    const expected = permissionKeys(await computePermissionSet(real, dir));

    const st = staticManifestOf(real);
    const bytes = await tgz(
      base({
        pkg: pkgJson({ capybara: section({ manifest: st, migrations: "migrations" }) }),
        extra: [{ name: "package/migrations/0001_init.sql", data: sql }],
      }),
    );
    const p = await readPluginPackage(bytes, OPTS);
    expect(permissionKeys(permissionSetOfPackage(p))).toEqual(expected);
    expect(expected).toContain("table:items");
    expect(expected).toContain("config.deployment.secret:nested.k");
  });
});

describe("extractPluginPackage", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "pkg-extract-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("解到目录并去掉 package/ 前缀", async () => {
    const bytes = await tgz(base({ extra: [{ name: "package/ui/a/b.html", data: "<b>" }] }));
    const out = join(dir, "a");
    await extractPluginPackage(bytes, out, OPTS);
    expect((await readdir(out)).sort()).toEqual(["dist", "package.json", "ui"]);
    expect(await readFile(join(out, "ui/a/b.html"), "utf8")).toBe("<b>");
    expect(await readFile(join(out, "dist/index.mjs"), "utf8")).toBe(ENTRY);
  });

  it("目标目录非空时拒绝", async () => {
    const out = join(dir, "b");
    await mkdir(out);
    await writeFile(join(out, "x"), "x");
    await expect(extractPluginPackage(await tgz(base()), out, OPTS)).rejects.toThrow(/not empty/);
  });

  it("与 readPluginPackage 用同一组上限（maxBytes / 条目数）", async () => {
    const bytes = await tgz(base());
    await expect(
      extractPluginPackage(bytes, join(dir, "d"), { maxBytes: bytes.byteLength - 1 }),
    ).rejects.toThrow(/larger than/);
    await expect(
      extractPluginPackage(bytes, join(dir, "e"), { maxBytes: OPTS.maxBytes, maxEntries: 1 }),
    ).rejects.toThrow(/more than 1 entries/);
    await expect(readdir(join(dir, "d"))).rejects.toThrow();
  });

  it("恶意包同样拒绝（不写出任何文件）", async () => {
    const out = join(dir, "c");
    const bytes = await tgz(base({ extra: [{ name: "package/../../x", data: "x" }] }));
    await expect(extractPluginPackage(bytes, out, OPTS)).rejects.toBeInstanceOf(PluginPackageError);
    await expect(readdir(out)).rejects.toThrow();
  });
});
