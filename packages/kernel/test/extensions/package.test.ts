import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  defineExtension,
  type PluginExtensionSection,
  SDK_VERSION,
  type StaticExtensionManifest,
  secret,
  staticManifestOf,
} from "@capybara-hq/plugin-sdk";
import { pack as tarPack } from "tar-stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { PluginPackageError, readPluginPackage } from "../../src/catalog/plugin-package.js";
import {
  ExtensionPackageError,
  extractExtensionPackage,
  permissionSetOfPackage,
  readExtensionPackage,
} from "../../src/extensions/package.js";
import { computePermissionSet, permissionKeys } from "../../src/extensions/permission-set.js";

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

const section = (over: Partial<PluginExtensionSection> = {}): PluginExtensionSection => ({
  entry: "./dist/index.mjs",
  manifest: manifest(),
  ...over,
});

/** plugin.json; `extension: undefined` makes a declarative plugin. */
const pluginJson = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    schemaVersion: 1,
    name: "demo",
    version: "1.0.0",
    publisher: "Acme",
    description: "Demo plugin",
    extension: section(),
    ...over,
  });

const pkgJson = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    name: "@acme/plugin-demo",
    version: "1.0.0",
    type: "module",
    peerDependencies: { "@capybara-hq/plugin-sdk": "^0.1.0", zod: "^4.0.0" },
    ...over,
  });

const ENTRY = [
  'import { readFile } from "node:fs/promises";',
  'import { z } from "zod";',
  'import { defineExtension } from "@capybara-hq/plugin-sdk";',
  "const meta = import.meta.url;",
  'export default defineExtension({ async setup() { await import("node:path"); } });',
].join("\n");

const base = (
  over: { pkg?: string; plugin?: string; entry?: string; extra?: Entry[] } = {},
): Entry[] => [
  { name: "package/package.json", data: over.pkg ?? pkgJson() },
  { name: "package/.capybara-plugin/plugin.json", data: over.plugin ?? pluginJson() },
  { name: "package/dist/index.mjs", data: over.entry ?? ENTRY },
  ...(over.extra ?? []),
];

const OPTS = { maxBytes: 10 * 1024 * 1024, hostSdkVersion: SDK_VERSION };

async function rejects(bytes: Uint8Array, re: RegExp, opts = OPTS): Promise<string[]> {
  const err = await readExtensionPackage(bytes, opts).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ExtensionPackageError);
  const issues = (err as ExtensionPackageError).issues;
  expect(issues.join("\n")).toMatch(re);
  return issues;
}

const LEGACY =
  "uses the pre-0.1.0 package format (capybara section / app.yaml); repack it as a plugin with .capybara-plugin/plugin.json (pnpm pack-plugin)";

const SKILL_MD =
  "---\nname: greet\ndescription: Greets the user. Use when the user says hello.\n---\n\nHi.\n";
const TEMPLATE = JSON.stringify({
  displayName: { zh: "示例", en: "Example" },
  template: {
    plugin: "connector-mcp",
    connector: "mcp",
    endpoint: { url: "https://x.example.com/mcp" },
    auth: { type: "none" },
  },
});

/** A declarative plugin (no extension, no peerDependencies) with the given files. */
const declarative = (extra: Entry[], over: Record<string, unknown> = {}): Entry[] => [
  { name: "package/package.json", data: pkgJson({ peerDependencies: undefined }) },
  {
    name: "package/.capybara-plugin/plugin.json",
    data: pluginJson({ extension: undefined, ...over }),
  },
  ...extra,
];

async function pluginRejects(entries: Entry[], re: RegExp): Promise<PluginPackageError> {
  const err = await readPluginPackage(await tgz(entries), OPTS).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(PluginPackageError);
  const e = err as PluginPackageError;
  expect(e.code).toBe("catalog.invalid_manifest");
  expect(e.issues.join("\n")).toMatch(re);
  return e;
}

describe("readExtensionPackage: valid packages", () => {
  it("returns sha256, size, package.json, the file list and the migration SQL", async () => {
    const bytes = await tgz(
      base({
        plugin: pluginJson({ extension: section({ migrations: "./migrations", ui: "./ui" }) }),
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
    const p = await readExtensionPackage(bytes, OPTS);
    expect(p.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(p.size).toBe(bytes.byteLength);
    expect(p.packageJson.name).toBe("@acme/plugin-demo");
    expect(p.section).toMatchObject({
      name: "demo",
      version: "1.0.0",
      entry: "./dist/index.mjs",
      migrations: "./migrations",
      ui: "./ui",
    });
    expect(p.section.manifest.name).toBe("demo");
    expect(p.files.map((f) => f.path).sort()).toEqual([
      ".capybara-plugin/plugin.json",
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

  it("also scans the modules that relative imports in the package point to", async () => {
    const ok = await tgz(
      base({
        entry: 'import "./chunk.mjs"; export default {};',
        extra: [{ name: "package/dist/chunk.mjs", data: 'import "node:os";' }],
      }),
    );
    await expect(readExtensionPackage(ok, OPTS)).resolves.toBeDefined();
    const bad = await tgz(
      base({
        entry: 'import "./chunk.mjs"; export default {};',
        extra: [{ name: "package/dist/chunk.mjs", data: 'import "lodash";' }],
      }),
    );
    await rejects(bad, /dist\/chunk\.mjs.*"lodash"/);
  });
});

describe("readExtensionPackage: the pre-0.1.0 format and plugins without an extension", () => {
  const legacyCode = async (bytes: Uint8Array) => {
    const err = await readExtensionPackage(bytes, OPTS).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ExtensionPackageError);
    return err as ExtensionPackageError;
  };

  it("a capybara section in package.json and no plugin.json -> extension.legacy_format", async () => {
    const old = pkgJson({
      capybara: { kind: "plugin", entry: "dist/index.mjs", sdk: "^0.1.0", manifest: manifest() },
    });
    const e = await legacyCode(
      await tgz([
        { name: "package/package.json", data: old },
        { name: "package/dist/index.mjs", data: ENTRY },
      ]),
    );
    expect(e.code).toBe("extension.legacy_format");
    expect(e.issues).toEqual([`Package @acme/plugin-demo ${LEGACY}`]);
    expect(e.message).toBe(`Package @acme/plugin-demo ${LEGACY}`);
  });

  it("app.yaml and no plugin.json -> extension.legacy_format", async () => {
    const e = await legacyCode(
      await tgz([
        { name: "package/package.json", data: pkgJson({ peerDependencies: undefined }) },
        { name: "package/app.yaml", data: "schemaVersion: 1\nname: demo\n" },
      ]),
    );
    expect(e.code).toBe("extension.legacy_format");
    expect(e.issues[0]).toContain(LEGACY);
  });

  it("a plugin without an extension -> extension.no_extension", async () => {
    const e = await legacyCode(
      await tgz(declarative([{ name: "package/skills/greet/SKILL.md", data: SKILL_MD }])),
    );
    expect(e.code).toBe("extension.no_extension");
    expect(e.issues[0]).toMatch(/plugin demo has no extension/);
  });

  it("no plugin.json and no old format -> extension.package_invalid naming the file", async () => {
    const e = await legacyCode(
      await tgz([
        { name: "package/package.json", data: pkgJson() },
        { name: "package/dist/index.mjs", data: ENTRY },
      ]),
    );
    expect(e.code).toBe("extension.package_invalid");
    expect(e.issues[0]).toMatch(/\.capybara-plugin\/plugin\.json not found/);
  });
});

describe("readPluginPackage", () => {
  it("reads a declarative plugin: skills and connector templates scanned when not listed", async () => {
    const p = await readPluginPackage(
      await tgz(
        declarative([
          { name: "package/skills/greet/SKILL.md", data: SKILL_MD },
          { name: "package/skills/greet/ref/notes.txt", data: "notes" },
          { name: "package/connectors/crm.json", data: TEMPLATE },
          { name: "package/README.md", data: "# demo" },
        ]),
      ),
      OPTS,
    );
    expect(p.manifest.name).toBe("demo");
    expect(p.manifest.extension).toBeUndefined();
    expect(p.skills).toEqual([
      { name: "greet", dir: "skills/greet", files: ["SKILL.md", "ref/notes.txt"] },
    ]);
    expect(p.connectorTemplates.map((t) => ({ id: t.id, path: t.path }))).toEqual([
      { id: "crm", path: "connectors/crm.json" },
    ]);
    expect(p.connectorTemplates[0]?.file.displayName.en).toBe("Example");
    expect(new TextDecoder().decode(p.files.get("README.md"))).toBe("# demo");
  });

  it("listed skills and templates are used instead of scanning", async () => {
    const p = await readPluginPackage(
      await tgz(
        declarative(
          [
            { name: "package/extra/greet/SKILL.md", data: SKILL_MD },
            { name: "package/skills/other/SKILL.md", data: "not read" },
            { name: "package/tpl/crm.json", data: TEMPLATE },
            { name: "package/connectors/bad.json", data: "not read" },
          ],
          {
            skills: [{ path: "./extra/greet", pinned: true }],
            connectorTemplates: [{ path: "./tpl/crm.json" }],
          },
        ),
      ),
      OPTS,
    );
    expect(p.skills.map((s) => s.dir)).toEqual(["extra/greet"]);
    expect(p.connectorTemplates.map((t) => t.id)).toEqual(["crm"]);
  });

  it("a legacy tgz -> catalog.legacy_format", async () => {
    const err = await readPluginPackage(
      await tgz([{ name: "package/package.json", data: pkgJson({ capybara: { kind: "skill" } }) }]),
      OPTS,
    ).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PluginPackageError);
    expect((err as PluginPackageError).code).toBe("catalog.legacy_format");
    expect((err as PluginPackageError).issues).toEqual([`Package @acme/plugin-demo ${LEGACY}`]);
  });

  // Review Focus 2: plugin.json that lies about its content is refused, naming the path.
  it("listed skill path that does not exist", async () => {
    await pluginRejects(
      declarative([{ name: "package/skills/greet/SKILL.md", data: SKILL_MD }], {
        skills: [{ path: "./skills/missing" }],
      }),
      /skills\.0: \.\/skills\/missing\/SKILL\.md not found/,
    );
  });

  it("listed connector template path that does not exist", async () => {
    await pluginRejects(
      declarative([{ name: "package/connectors/crm.json", data: TEMPLATE }], {
        connectorTemplates: [{ path: "./connectors/nope.json" }],
      }),
      /connectorTemplates\.0: \.\/connectors\/nope\.json not found/,
    );
  });

  it("extension.entry missing from the tgz", async () => {
    await pluginRejects(
      [
        { name: "package/package.json", data: pkgJson() },
        { name: "package/.capybara-plugin/plugin.json", data: pluginJson() },
      ],
      /extension\.entry: \.\/dist\/index\.mjs not found/,
    );
  });

  it("extension name differs from the plugin name", async () => {
    await pluginRejects(
      base({ plugin: pluginJson({ name: "other" }) }),
      /extension name "[^"]*" must equal the plugin name "other"/,
    );
  });

  it("plugin.json version differs from package.json", async () => {
    await pluginRejects(
      base({ pkg: pkgJson({ version: "1.0.1" }) }),
      /package\.json version "1\.0\.1" does not match plugin\.json version "1\.0\.0"/,
    );
  });

  it("a scanned connectors/x.json that is invalid", async () => {
    await pluginRejects(
      declarative([
        { name: "package/connectors/x.json", data: JSON.stringify({ displayName: "x" }) },
      ]),
      /connectors\/x\.json: /,
    );
    await pluginRejects(
      declarative([{ name: "package/connectors/y.json", data: "{nope" }]),
      /connectors\/y\.json: .*is not valid JSON/,
    );
  });

  it("a connectors/x.json over the manifest size limit is refused", async () => {
    const big = JSON.stringify({ displayName: "x", pad: "a".repeat(256 * 1024) });
    await pluginRejects(
      declarative([{ name: "package/connectors/big.json", data: big }]),
      /connectors\/big\.json: .*is larger than 262144 characters/,
    );
  });

  it("a scanned SKILL.md that is invalid, and duplicate skill names", async () => {
    await pluginRejects(
      declarative([{ name: "package/skills/bad/SKILL.md", data: "no frontmatter" }]),
      /skills\/bad\/SKILL\.md: /,
    );
    await pluginRejects(
      declarative([
        { name: "package/skills/a/SKILL.md", data: SKILL_MD },
        { name: "package/skills/b/SKILL.md", data: SKILL_MD },
      ]),
      /skills\/b\/SKILL\.md: skill name "greet" is also used by skills\/a/,
    );
  });

  it("listed migrations / ui directory missing, icon missing", async () => {
    await pluginRejects(
      base({ plugin: pluginJson({ extension: section({ migrations: "./migrations" }) }) }),
      /extension\.migrations: directory \.\/migrations is missing or empty/,
    );
    await pluginRejects(
      base({ plugin: pluginJson({ icon: "./icon.svg" }) }),
      /icon: \.\/icon\.svg not found/,
    );
  });

  it("a plugin with nothing in it", async () => {
    await pluginRejects(
      declarative([]),
      /a plugin must contain an extension, a skill or a connector template/,
    );
  });

  it("a declarative plugin with peerDependencies", async () => {
    await pluginRejects(
      [
        { name: "package/package.json", data: pkgJson() },
        {
          name: "package/.capybara-plugin/plugin.json",
          data: pluginJson({ extension: undefined }),
        },
        { name: "package/skills/greet/SKILL.md", data: SKILL_MD },
      ],
      /peerDependencies is not allowed/,
    );
  });

  it("an old app bundle with a broken package.json is still legacy (app.yaml is checked first)", async () => {
    const err = await readPluginPackage(
      await tgz([
        { name: "package/package.json", data: "{not json" },
        { name: "package/app.yaml", data: "schemaVersion: 1\n" },
      ]),
      OPTS,
    ).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PluginPackageError);
    expect((err as PluginPackageError).code).toBe("catalog.legacy_format");
    expect((err as PluginPackageError).issues).toEqual([`The package ${LEGACY}`]);
  });

  it("icons must really be svg / png and at most 64KB (plugin and connector template icons)", async () => {
    const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
    const skill = { name: "package/skills/greet/SKILL.md", data: SKILL_MD };
    const ok = await readPluginPackage(
      await tgz(
        declarative([skill, { name: "package/icon.png", data: PNG }], { icon: "./icon.png" }),
      ),
      OPTS,
    );
    expect(ok.manifest.icon).toBe("./icon.png");
    await pluginRejects(
      declarative([skill, { name: "package/icon.png", data: "GIF89a" }], { icon: "./icon.png" }),
      /icon: \.\/icon\.png is not a PNG image/,
    );
    await pluginRejects(
      declarative([skill, { name: "package/icon.svg", data: "<html></html>" }], {
        icon: "./icon.svg",
      }),
      /icon: \.\/icon\.svg is not an SVG document/,
    );
    await pluginRejects(
      declarative([skill, { name: "package/icon.svg", data: `<svg>${"x".repeat(70_000)}</svg>` }], {
        icon: "./icon.svg",
      }),
      /icon: \.\/icon\.svg is larger than 65536 bytes/,
    );
    const tpl = JSON.stringify({ ...JSON.parse(TEMPLATE), icon: "./icons/crm.svg" });
    await pluginRejects(
      declarative([
        { name: "package/connectors/crm.json", data: tpl },
        { name: "package/icons/crm.svg", data: "not svg" },
      ]),
      /connectors\/crm\.json: icon \.\/icons\/crm\.svg is not an SVG document/,
    );
  });

  it("plugin.json and a capybara section together -> invalid, not legacy", async () => {
    await pluginRejects(
      base({ pkg: pkgJson({ capybara: { kind: "plugin" } }) }),
      /must not have a capybara section/,
    );
  });
});

describe("readExtensionPackage: invalid packages", () => {
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

  it("SDK range not satisfied", async () => {
    const s = section({ manifest: manifest({ sdk: "^9.0.0" }) });
    await rejects(
      await tgz(
        base({
          pkg: pkgJson({ peerDependencies: { "@capybara-hq/plugin-sdk": "^9.0.0" } }),
          plugin: pluginJson({ extension: s }),
        }),
      ),
      /not satisfied/,
    );
  });

  it("peerDependencies.zod 不被宿主的 zod 满足（默认取内核自己的 zod 版本）", async () => {
    const pkg = pkgJson({
      peerDependencies: { "@capybara-hq/plugin-sdk": "^0.1.0", zod: "^3.0.0" },
    });
    await rejects(await tgz(base({ pkg })), /zod "\^3\.0\.0" is not satisfied by the host zod 4\./);
  });

  it("version mismatch", async () => {
    await rejects(
      await tgz(base({ pkg: pkgJson({ version: "1.0.1" }) })),
      /does not match plugin\.json version/,
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
    await rejects(
      await tgz([
        { name: "package/.capybara-plugin/plugin.json", data: pluginJson() },
        { name: "package/dist/index.mjs", data: ENTRY },
      ]),
      /package\.json/,
    );
  });

  it("package.json 不是合法 JSON", async () => {
    await rejects(await tgz(base({ pkg: "{nope" })), /not valid JSON/);
  });

  it("package.json 过大", async () => {
    const big = pkgJson({ description: "x".repeat(2 * 1024 * 1024) });
    await rejects(await tgz(base({ pkg: big })), /package\.json is larger/);
  });

  it("entry missing", async () => {
    await rejects(
      await tgz([
        { name: "package/package.json", data: pkgJson() },
        { name: "package/.capybara-plugin/plugin.json", data: pluginJson() },
      ]),
      /extension\.entry: \.\/dist\/index\.mjs not found/,
    );
  });

  it("migrations declared but the directory is missing", async () => {
    await rejects(
      await tgz(
        base({ plugin: pluginJson({ extension: section({ migrations: "./migrations" }) }) }),
      ),
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
        plugin: pluginJson({ extension: section({ manifest: st, migrations: "./migrations" }) }),
        extra: [{ name: "package/migrations/0001_init.sql", data: sql }],
      }),
    );
    const p = await readExtensionPackage(bytes, OPTS);
    expect(permissionKeys(permissionSetOfPackage(p))).toEqual(expected);
    expect(expected).toContain("table:items");
    expect(expected).toContain("config.deployment.secret:nested.k");
  });
});

describe("extractExtensionPackage", () => {
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
    await extractExtensionPackage(bytes, out, OPTS);
    expect((await readdir(out)).sort()).toEqual([".capybara-plugin", "dist", "package.json", "ui"]);
    expect(await readFile(join(out, "ui/a/b.html"), "utf8")).toBe("<b>");
    expect(await readFile(join(out, "dist/index.mjs"), "utf8")).toBe(ENTRY);
  });

  it("目标目录非空时拒绝", async () => {
    const out = join(dir, "b");
    await mkdir(out);
    await writeFile(join(out, "x"), "x");
    await expect(extractExtensionPackage(await tgz(base()), out, OPTS)).rejects.toThrow(
      /not empty/,
    );
  });

  it("uses the same limits as readExtensionPackage (maxBytes / entry count)", async () => {
    const bytes = await tgz(base());
    await expect(
      extractExtensionPackage(bytes, join(dir, "d"), { maxBytes: bytes.byteLength - 1 }),
    ).rejects.toThrow(/larger than/);
    await expect(
      extractExtensionPackage(bytes, join(dir, "e"), { maxBytes: OPTS.maxBytes, maxEntries: 1 }),
    ).rejects.toThrow(/more than 1 entries/);
    await expect(readdir(join(dir, "d"))).rejects.toThrow();
  });

  it("恶意包同样拒绝（不写出任何文件）", async () => {
    const out = join(dir, "c");
    const bytes = await tgz(base({ extra: [{ name: "package/../../x", data: "x" }] }));
    await expect(extractExtensionPackage(bytes, out, OPTS)).rejects.toBeInstanceOf(
      ExtensionPackageError,
    );
    await expect(readdir(out)).rejects.toThrow();
  });
});
