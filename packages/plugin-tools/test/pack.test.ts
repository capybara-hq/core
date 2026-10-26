import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { computePermissionSet, permissionKeys, permissionSetOfPackage } from "@capybara-hq/kernel";
import {
  type ExtensionManifest,
  PLUGIN_MANIFEST_FILE,
  type PluginManifest,
  parsePluginManifest,
  SDK_VERSION,
  staticManifestOf,
  validatePluginPackageJsonFor,
} from "@capybara-hq/plugin-sdk";
import { extract } from "tar-stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NOTICES_FILE, packPlugin } from "../src/pack/index.js";

// Pass-through spies: the declarative test asserts that esbuild and the staging dir are not used.
const spies = vi.hoisted(() => ({
  build: vi.fn(),
  mkdtemp: vi.fn(),
  /** When set, node:zlib's gzip writes this OS byte (offset 9), like zlib built for that host. */
  gzipOs: undefined as number | undefined,
}));
vi.mock("esbuild", async (importOriginal) => {
  const orig = await importOriginal<typeof import("esbuild")>();
  spies.build.mockImplementation(orig.build);
  return { ...orig, build: spies.build };
});
vi.mock("node:zlib", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:zlib")>();
  const gzip = (buf: Buffer, opts: object, cb: (e: Error | null, r?: Buffer) => void) =>
    orig.gzip(buf, opts, (e, r) => {
      if (r !== undefined && spies.gzipOs !== undefined) r[9] = spies.gzipOs;
      cb(e, r);
    });
  return { ...orig, gzip };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:fs/promises")>();
  spies.mkdtemp.mockImplementation(orig.mkdtemp);
  return { ...orig, mkdtemp: spies.mkdtemp };
});

/** Every entry of a tgz (paths without the `package/` prefix). */
async function readTgz(file: string): Promise<Map<string, Buffer>> {
  const entries = new Map<string, Buffer>();
  const ex = extract();
  const done = (async () => {
    for await (const e of ex) {
      const chunks: Buffer[] = [];
      for await (const c of e) chunks.push(c as Buffer);
      entries.set(e.header.name.replace(/^package\//, ""), Buffer.concat(chunks));
    }
  })();
  ex.end(gunzipSync(await readFile(file)));
  await done;
  return entries;
}

const text = (entries: Map<string, Buffer>, path: string) => {
  const b = entries.get(path);
  if (b === undefined) throw new Error(`${path} is not in the package`);
  return b.toString("utf8");
};
const json = (entries: Map<string, Buffer>, path: string) =>
  JSON.parse(text(entries, path)) as Record<string, unknown>;

/** The packed plugin.json, parsed with the SDK (fails the test on errors). */
function manifestOf(entries: Map<string, Buffer>): PluginManifest {
  const m = parsePluginManifest(text(entries, PLUGIN_MANIFEST_FILE));
  if ("errors" in m) throw new Error(m.errors.join("; "));
  return m;
}

const repo = fileURLToPath(new URL("../../../", import.meta.url));
/**
 * The fake extensions of @capybara-hq/testing (core's test extensions; the official plugins leave
 * this repository): fake-tools-ui has a migration, a skill and a connector template, fake-connector
 * bundles a third-party dependency (@modelcontextprotocol/sdk).
 */
const plugin = (name: string) => join(repo, "packages/testing/fixtures/extensions", name);
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

let out: string;
beforeAll(async () => {
  out = await mkdtemp(join(tmpdir(), "pack-plugin-"));
});
afterAll(async () => {
  await rm(out, { recursive: true, force: true });
});

const realManifest = async (name: string) =>
  ((await import(join(plugin(name), "src/index.ts"))) as { default: ExtensionManifest }).default;

describe.each(["fake-tools-ui", "fake-connector"])("packPlugin(%s)", (name) => {
  let result: Awaited<ReturnType<typeof packPlugin>>;
  let bytes: Uint8Array;
  let entries: Map<string, Buffer>;
  beforeAll(async () => {
    result = await packPlugin(plugin(name), out);
    bytes = new Uint8Array(await readFile(result.file));
    entries = await readTgz(result.file);
  }, 60_000);

  it("writes an npm-style named tgz whose sha256 matches the file", () => {
    expect(basename(result.file)).toBe(`capybara-hq-test-plugin-${name}-0.1.0.tgz`);
    expect(result.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(result.manifest.name).toBe(name);
  });

  it("writes .capybara-plugin/plugin.json with the extension the module declares", async () => {
    const m = manifestOf(entries);
    expect(m).toEqual(result.manifest);
    expect(m.name).toBe(name);
    expect(m.publisher).toBe("Capybara");
    expect(m.extension?.entry).toBe("./dist/index.mjs");
    expect(m.extension?.manifest).toEqual(staticManifestOf(await realManifest(name)));
    expect(entries.has("dist/index.mjs")).toBe(true);
    expect([...entries.keys()].some((x) => x.includes("node_modules"))).toBe(false);
  });

  it("package.json keeps only the listed fields and has no capybara section", () => {
    const pkg = json(entries, "package.json");
    // The fakes are private and have no homepage or repository (the metadata fixture has them).
    expect(Object.keys(pkg).sort()).toEqual(
      ["description", "license", "name", "peerDependencies", "type", "version"].sort(),
    );
    expect(pkg.name).toBe(`@capybara-hq/test-plugin-${name}`);
    expect(pkg.private).toBeUndefined();
    expect(Object.keys(pkg.peerDependencies as object).sort()).toEqual([
      "@capybara-hq/plugin-sdk",
      "zod",
    ]);
    expect(validatePluginPackageJsonFor(pkg, manifestOf(entries), SDK_VERSION)).toEqual([]);
  });

  it("the permission keys of the packed manifest equal computePermissionSet(real module)", async () => {
    const m = manifestOf(entries);
    const ext = m.extension as NonNullable<PluginManifest["extension"]>;
    const section = { ...ext, name: m.name, version: m.version };
    const migrationSql = [...entries.keys()]
      .filter((p) => p.startsWith("migrations/"))
      .sort()
      .map((p) => ({ file: p.slice("migrations/".length), sql: text(entries, p) }));
    const real = await realManifest(name);
    const expected = permissionKeys(await computePermissionSet(real, join(plugin(name), "src")));
    // permissionSetOfPackage reads only the section and the migration SQL.
    const p = { sha256: "", size: 0, packageJson: {}, section, files: [], migrationSql };
    expect(permissionKeys(permissionSetOfPackage(p))).toEqual(expected);
  });

  it("leaves no temporary files in the plugin dir", async () => {
    expect((await readdir(plugin(name))).filter((f) => f.startsWith(".capybara-pack"))).toEqual([]);
  });
});

describe("packPlugin: other behavior", () => {
  beforeEach(() => {
    spies.build.mockClear();
    spies.mkdtemp.mockClear();
  });

  it("fake-tools-ui: ships the migrations; extension.migrations is ./migrations", async () => {
    const r = await packPlugin(plugin("fake-tools-ui"), out);
    const entries = await readTgz(r.file);
    expect(manifestOf(entries).extension?.migrations).toBe("./migrations");
    expect([...entries.keys()].filter((p) => p.startsWith("migrations/")).length).toBeGreaterThan(
      0,
    );
  }, 60_000);

  it("fake-embed: ships no ui/ section when the plugin has no ui dir", async () => {
    const r = await packPlugin(plugin("fake-embed"), out);
    expect(r.manifest.extension?.ui).toBeUndefined();
  }, 60_000);

  it("the same input yields the same bytes (reproducible)", async () => {
    const a = await packPlugin(plugin("fake-tools-ui"), join(out, "a"));
    const b = await packPlugin(plugin("fake-tools-ui"), join(out, "b"));
    expect(a.sha256).toBe(b.sha256);
  }, 60_000);

  it("the gzip header carries no host-specific bytes (same bytes on macOS, Linux and Windows)", async () => {
    // zlib writes the host OS into the gzip header (RFC 1952 OS byte: 0x13 on macOS, 0x03 on
    // Unix, 0x0a on Windows); simulate a macOS zlib on every host and expect a Linux-identical pack.
    const linux = await packPlugin(plugin("fake-tools-ui"), join(out, "os-linux"));
    try {
      spies.gzipOs = 0x13;
      const mac = await packPlugin(plugin("fake-tools-ui"), join(out, "os-mac"));
      expect(mac.sha256).toBe(linux.sha256);
    } finally {
      spies.gzipOs = undefined;
    }
    const header = (await readFile(linux.file)).subarray(0, 10);
    // magic, deflate, no flags, mtime 0, XFL 2 (level 9), OS 3 (Unix)
    expect([...header]).toEqual([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 2, 3]);
  }, 60_000);

  it("never creates a staging dir in the plugin source tree (it lives in the system temp dir)", async () => {
    let done = false;
    const seen = new Set<string>();
    const watch = (async () => {
      while (!done) {
        for (const f of await readdir(plugin("fake-tools-ui"))) {
          if (f.startsWith(".capybara-pack")) seen.add(f);
        }
        await new Promise((r) => setImmediate(r));
      }
    })();
    try {
      await packPlugin(plugin("fake-tools-ui"), join(out, "watch"));
    } finally {
      done = true;
      await watch;
    }
    expect([...seen]).toEqual([]);
  }, 60_000);

  it("a declarative plugin ships skills and connectors, has no extension and runs no esbuild", async () => {
    const r = await packPlugin(fixture("declarative"), out);
    const entries = await readTgz(r.file);
    expect([...entries.keys()].sort()).toEqual(
      [
        ".capybara-plugin/plugin.json",
        "LICENSE",
        "NOTICE",
        "connectors/x.json",
        "package.json",
        "skills/greet/SKILL.md",
        "skills/greet/template.txt",
      ].sort(),
    );
    const m = manifestOf(entries);
    expect(m.extension).toBeUndefined();
    expect(r.manifest).toEqual(m);
    const pkg = json(entries, "package.json");
    expect(pkg.capybara).toBeUndefined();
    expect(pkg.peerDependencies).toBeUndefined();
    expect(validatePluginPackageJsonFor(pkg, m, SDK_VERSION)).toEqual([]);
    expect(spies.build).not.toHaveBeenCalled();
    expect(spies.mkdtemp).not.toHaveBeenCalled();
    expect(r.dropped).toEqual([]);
  });

  it("the declarative plugin packs reproducibly", async () => {
    const a = await packPlugin(fixture("declarative"), join(out, "da"));
    const b = await packPlugin(fixture("declarative"), join(out, "db"));
    expect(a.sha256).toBe(b.sha256);
  });

  describe("source plugin.json", () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "pack-plugin-src-"));
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ name: "@x/plugin-src", version: "0.1.0", type: "module" }),
      );
      await mkdir(join(dir, "skills/a"), { recursive: true });
      await writeFile(join(dir, "skills/a/SKILL.md"), "---\nname: a\ndescription: A.\n---\n");
      return () => rm(dir, { recursive: true, force: true });
    });
    const writeManifest = async (m: Record<string, unknown>) => {
      await mkdir(join(dir, ".capybara-plugin"), { recursive: true });
      await writeFile(join(dir, PLUGIN_MANIFEST_FILE), JSON.stringify(m));
    };
    const base = {
      schemaVersion: 1,
      name: "src",
      version: "0.1.0",
      publisher: "Capybara",
      description: "Source manifest tests",
    };

    it("a plugin dir without .capybara-plugin/plugin.json fails", async () => {
      await expect(packPlugin(dir, out)).rejects.toThrow(/missing \.capybara-plugin\/plugin\.json/);
    });

    it("a source plugin.json with an extension key fails", async () => {
      await writeManifest({
        ...base,
        extension: { entry: "./dist/index.mjs", manifest: {} },
      });
      await expect(packPlugin(dir, out)).rejects.toThrow(/extension is written by the packer/);
    });

    it("an invalid source plugin.json fails with the parser's message", async () => {
      await writeManifest({ ...base, publisher: undefined, color: "red" });
      await expect(packPlugin(dir, out)).rejects.toThrow(/plugin\.json.*publisher/);
    });

    it("a listed skill path that does not exist fails", async () => {
      await writeManifest({ ...base, skills: [{ path: "./skills/missing" }] });
      await expect(packPlugin(dir, out)).rejects.toThrow(/\.\/skills\/missing.*SKILL\.md/);
    });

    it("an invalid connectors/*.json fails with its path", async () => {
      await writeManifest(base);
      await mkdir(join(dir, "connectors"));
      await writeFile(join(dir, "connectors/bad.json"), JSON.stringify({ displayName: "x" }));
      await expect(packPlugin(dir, out)).rejects.toThrow(/connectors\/bad\.json/);
    });

    it("a plugin with no extension, skill or connector template fails", async () => {
      await rm(join(dir, "skills"), { recursive: true });
      await writeManifest(base);
      await expect(packPlugin(dir, out)).rejects.toThrow(
        /a plugin must contain an extension, a skill or a connector template/,
      );
    });

    it("a source plugin.json version that differs from package.json fails", async () => {
      await writeManifest({ ...base, version: "0.2.0" });
      await expect(packPlugin(dir, out)).rejects.toThrow(/0\.1\.0.*0\.2\.0/);
    });
  });

  it("a plugin with a non-literal dynamic import fails to pack", async () => {
    await expect(packPlugin(fixture("dynamic-import"), out)).rejects.toThrow(/non-literal/);
    expect((await readdir(fixture("dynamic-import"))).sort()).toEqual([
      ".capybara-plugin",
      "package.json",
      "src",
    ]);
  });

  it("fake-connector: ships LICENSE, NOTICE and the bundled dependencies' notices", async () => {
    const r = await packPlugin(plugin("fake-connector"), out);
    const entries = await readTgz(r.file);
    for (const f of ["LICENSE", "NOTICE", NOTICES_FILE]) {
      expect(entries.has(f)).toBe(true);
    }
    expect(r.dropped).toEqual([]);
    const notices = text(entries, NOTICES_FILE);
    expect(notices).toMatch(/^-{72}\n@modelcontextprotocol\/sdk@\S+ \(MIT\)/m);
    expect(notices).toContain("Permission is hereby granted");
    expect(text(entries, "LICENSE")).toBe(await readFile(join(repo, "LICENSE"), "utf8"));
    // Apache-2.0 4(d): the repository's NOTICE travels with its LICENSE.
    expect(text(entries, "NOTICE")).toBe(await readFile(join(repo, "NOTICE"), "utf8"));
  }, 60_000);

  it("ships plain files listed in `files` and reports entries it cannot ship", async () => {
    const r = await packPlugin(fixture("metadata"), out);
    const paths = [...(await readTgz(r.file)).keys()];
    expect(paths).toEqual(
      expect.arrayContaining(["README.md", "LICENSE", "notes.txt", "dist/index.mjs"]),
    );
    expect(paths.some((x) => x.startsWith("assets/"))).toBe(false);
    expect(r.dropped).toEqual(["assets", "missing.txt"]);
  });

  it("passes homepage and keywords through when the source package.json has them", async () => {
    const r = await packPlugin(fixture("metadata"), out);
    const pkg = json(await readTgz(r.file), "package.json");
    expect(pkg.homepage).toBe("https://example.com/metadata");
    expect(pkg.keywords).toEqual(["capybara", "fixture"]);
    expect(pkg.repository).toEqual({
      type: "git",
      url: "git+https://github.com/capybara-hq/core.git",
      directory: "packages/plugin-tools/test/fixtures/metadata",
    });
  });

  it("fails when the extension version differs from package.json", async () => {
    await expect(packPlugin(fixture("version-mismatch"), out)).rejects.toThrow(
      /version.*0\.1\.0.*0\.2\.0/,
    );
  });
});
