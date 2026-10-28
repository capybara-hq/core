import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseMarketplaceManifest } from "@capybara-hq/plugin-sdk";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { integrityOf } from "../src/integrity.js";
import { marketplaceCommand, syncMarketplace } from "../src/marketplace/index.js";
import { packPlugin } from "../src/pack/index.js";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

let root: string;
let file: string;
/** The packs of the two public plugins (name -> integrity), taken before any test runs. */
const integrity = new Map<string, string>();

const EMPTY = { schemaVersion: 1, name: "Test marketplace", owner: { name: "Test" }, plugins: [] };
const writeManifest = (m: unknown) => writeFileSync(file, `${JSON.stringify(m, null, 2)}\n`);
interface Manifest {
  name: string;
  owner?: unknown;
  plugins: Record<string, unknown>[];
}
const readManifest = () => JSON.parse(readFileSync(file, "utf8")) as Manifest;

/** Copies a plugin into the temp repository, public (or private) as asked. */
function copyPlugin(from: string, dir: string, isPrivate: boolean): void {
  cpSync(from, join(root, "plugins", dir), { recursive: true });
  const pj = join(root, "plugins", dir, "package.json");
  const pkg = JSON.parse(readFileSync(pj, "utf8")) as Record<string, unknown>;
  pkg.private = isPrivate;
  writeFileSync(pj, JSON.stringify(pkg, null, 2));
}

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "marketplace-")));
  // the host packages the extension bundles resolve, as in a plugin repository's node_modules
  mkdirSync(join(root, "node_modules/@capybara-hq"), { recursive: true });
  symlinkSync(
    join(repo, "packages/plugin-sdk"),
    join(root, "node_modules/@capybara-hq/plugin-sdk"),
  );
  symlinkSync(
    await realpath(join(repo, "packages/plugin-tools/node_modules/zod")),
    join(root, "node_modules/zod"),
  );
  copyPlugin(fixture("declarative"), "declarative", false);
  copyPlugin(join(repo, "packages/testing/fixtures/extensions/fake-tools-ui"), "tools-ui", false);
  copyPlugin(fixture("declarative"), "example-private", true);
  mkdirSync(join(root, ".capybara-plugin"));
  file = join(root, ".capybara-plugin/marketplace.json");
  for (const [dir, name] of [
    ["declarative", "fixture-declarative"],
    ["tools-ui", "fake-tools-ui"],
  ] as const) {
    const r = await packPlugin(join(root, "plugins", dir), join(root, "ref"));
    integrity.set(name, integrityOf(new Uint8Array(await readFile(r.file))));
  }
}, 120_000);
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});
beforeEach(() => writeManifest(EMPTY));

const sync = (write: boolean) => syncMarketplace({ root, file, write });
/** A listed entry of a version no longer in the tree. */
const old2 = (name: string) => ({
  name,
  version: "0.0.1",
  summary: { en: name },
  source: {
    npm: { package: `@acme/${name}`, version: "0.0.1", integrity: `sha512-${"A".repeat(86)}==` },
  },
});

describe("capybara-plugin marketplace", () => {
  it("--check reports every public plugin version that is not listed, and writes nothing", async () => {
    const r = await sync(false);
    expect(r.findings.map((f) => [f.rule, f.message.split(" ")[0]])).toEqual([
      ["marketplace-missing", "fixture-declarative@0.1.0"],
      ["marketplace-missing", "fake-tools-ui@0.1.0"],
    ]);
    expect(readManifest()).toEqual(EMPTY);
  }, 60_000);

  it("--write appends one npm entry per (name, version) with the pack's sha512 and permissions", async () => {
    const r = await sync(true);
    expect(r.findings).toEqual([]);
    const m = readManifest();
    expect(m.name).toBe(EMPTY.name);
    expect(m.owner).toEqual(EMPTY.owner);
    expect(m.plugins).toEqual([
      {
        name: "fixture-declarative",
        version: "0.1.0",
        summary: { en: "Fixture: a plugin with skills and a connector template and no extension" },
        permissions: { keys: [], sensitive: [] },
        source: {
          npm: {
            package: "@capybara-hq/plugin-fixture-declarative",
            version: "0.1.0",
            integrity: integrity.get("fixture-declarative"),
          },
        },
      },
      expect.objectContaining({
        name: "fake-tools-ui",
        version: "0.1.0",
        source: {
          npm: {
            package: "@capybara-hq/test-plugin-fake-tools-ui",
            version: "0.1.0",
            integrity: integrity.get("fake-tools-ui"),
          },
        },
      }),
    ]);
    const tools = m.plugins[1] as { permissions: { keys: string[]; sensitive: string[] } };
    expect(tools.permissions.keys).toContain("permissions.tools:write");
    expect(tools.permissions.sensitive).toEqual(["permissions.tools:write"]);
    expect("errors" in parseMarketplaceManifest(m)).toBe(false);
    // up to date now: --check passes and another --write changes nothing
    expect((await sync(false)).findings).toEqual([]);
    const before = readFileSync(file, "utf8");
    expect((await sync(true)).added).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe(before);
  }, 60_000);

  it("keeps entries of versions no longer in the tree", async () => {
    await sync(true);
    const m = readManifest();
    const old = {
      ...(m.plugins[0] as object),
      version: "0.0.9",
      source: {
        npm: {
          package: "@capybara-hq/plugin-fixture-declarative",
          version: "0.0.9",
          integrity: `sha512-${"A".repeat(86)}==`,
        },
      },
    };
    writeManifest({ ...m, plugins: [old, ...m.plugins] });
    expect((await sync(false)).findings).toEqual([]);
    expect(readManifest().plugins).toHaveLength(3);
  }, 60_000);

  it("an already listed version is not compared with the tree's pack (the publish gate owns it)", async () => {
    // after a release, a source or toolchain change packs other bytes at the same version: an
    // ordinary PR must stay green, and other plugins' new entries must still be written
    await sync(true);
    const m = readManifest();
    const drifted = structuredClone(m);
    (drifted.plugins[0] as { source: { npm: { integrity: string } } }).source.npm.integrity =
      `sha512-${"B".repeat(86)}==`;
    drifted.plugins.splice(1, 1); // fake-tools-ui is not listed yet
    writeManifest(drifted);
    expect((await sync(false)).findings.map((f) => f.rule)).toEqual(["marketplace-missing"]);
    const r = await sync(true);
    expect(r.findings).toEqual([]);
    expect(r.added.map((e) => e.name)).toEqual(["fake-tools-ui"]);
    expect(readManifest().plugins.map((e) => e.name)).toEqual([
      "fixture-declarative",
      "fake-tools-ui",
    ]);
  }, 60_000);

  describe("--base: published entries are append-only", () => {
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    let base: string;
    beforeAll(() => {
      writeFileSync(join(root, ".gitignore"), "node_modules\nref\n");
      git("init", "-q", "-b", "main");
      git("config", "user.name", "t");
      git("config", "user.email", "t@example.com");
      git("config", "commit.gpgsign", "false");
    });
    beforeEach(async () => {
      writeManifest(EMPTY);
      await sync(true);
      git("add", "-A");
      git("commit", "-q", "--allow-empty", "-m", "base");
      base = git("rev-parse", "HEAD").trim();
    }, 60_000);
    const check = () => syncMarketplace({ root, file, write: false, base });
    const old = (name: string, version: string) => ({
      name,
      version,
      summary: { en: name },
      source: {
        npm: {
          package: `@capybara-hq/plugin-${name}`,
          version,
          integrity: `sha512-${"A".repeat(86)}==`,
        },
      },
    });

    it("passes when entries are only appended", async () => {
      const m = readManifest();
      writeManifest({ ...m, plugins: [...m.plugins, old("later", "9.0.0")] });
      expect((await check()).findings).toEqual([]);
    }, 60_000);

    it("reports an edited, a removed and a reordered published entry", async () => {
      const m = readManifest();
      const edited = structuredClone(m);
      (edited.plugins[0] as { summary: { en: string } }).summary.en = "changed";
      writeManifest(edited);
      expect((await check()).findings.map((f) => [f.rule, f.message.split(" ")[0]])).toEqual([
        ["marketplace-append-only", "fixture-declarative@0.1.0"],
      ]);
      writeManifest({ ...m, plugins: [m.plugins[1]] });
      const removed = (await check()).findings.filter((f) => f.rule !== "marketplace-missing");
      expect(removed.map((f) => f.rule)).toEqual([
        "marketplace-append-only",
        "marketplace-append-only",
      ]);
      expect(removed[0]?.message).toContain("fixture-declarative@0.1.0");
      writeManifest({ ...m, plugins: [m.plugins[1], m.plugins[0]] });
      expect((await check()).findings.map((f) => f.rule)).toContain("marketplace-append-only");
    }, 60_000);

    it("an entry added since the base must match the tree's pack", async () => {
      writeManifest(EMPTY);
      git("add", "-A");
      git("commit", "-q", "-m", "empty");
      base = git("rev-parse", "HEAD").trim();
      await sync(true);
      expect((await check()).findings).toEqual([]);
      const m = readManifest();
      (m.plugins[0] as { source: { npm: { integrity: string } } }).source.npm.integrity =
        `sha512-${"B".repeat(86)}==`;
      writeManifest(m);
      const f = (await check()).findings;
      expect(f.map((x) => x.rule)).toEqual(["marketplace-integrity"]);
      expect(f[0]?.message).toContain(integrity.get("fixture-declarative"));
    }, 60_000);

    it("the command takes --base with --check only", async () => {
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        expect(await marketplaceCommand(["--check", "--base", base], root)).toBe(0);
        const m = readManifest();
        writeManifest({ ...m, plugins: [m.plugins[1], m.plugins[0]] });
        expect(await marketplaceCommand(["--check", "--base", base], root)).toBe(1);
        expect(await marketplaceCommand(["--write", "--base", base], root)).toBe(2);
      } finally {
        err.mockRestore();
        log.mockRestore();
      }
    }, 60_000);

    it("a base without the file allows anything to be added", async () => {
      expect(
        (
          await syncMarketplace({
            root,
            file,
            write: false,
            base: git("rev-list", "--max-parents=0", "HEAD").trim(),
          })
        ).findings,
      ).toEqual([]);
    }, 60_000);
  });

  it("--write output is Biome-clean, arrays collapsed where they fit", async () => {
    await sync(true);
    const { formatMarketplaceJson } = await import("../src/marketplace/marketplace.js");
    expect(readFileSync(file, "utf8")).toBe(formatMarketplaceJson(readManifest()));
    const m = readManifest();
    // arrays around the 100-column limit: collapsed when they fit, one item per line otherwise
    const fits = (n: number) => Array.from({ length: n }, (_, i) => `permissions.tools:t${i}`);
    for (const n of [1, 2, 3, 4, 5, 6]) {
      m.plugins.push({ ...old2(`p${n}`), permissions: { keys: fits(n), sensitive: fits(n) } });
    }
    writeManifest(m);
    const text = formatMarketplaceJson(readManifest());
    const biome = join(repo, "node_modules/.bin/biome");
    const formatted = execFileSync(
      biome,
      ["format", `--config-path=${repo}`, "--stdin-file-path=marketplace.json"],
      { input: text, encoding: "utf8" },
    );
    expect(text).toBe(formatted);
    expect(JSON.parse(text)).toEqual(readManifest());
  }, 60_000);

  it("a manifest that does not parse is marketplace-invalid", async () => {
    writeManifest({ schemaVersion: 2, name: "x", plugins: [] });
    expect((await sync(false)).findings.map((f) => f.rule)).toEqual(["marketplace-invalid"]);
    writeFileSync(file, "{ nope");
    expect((await sync(true)).findings.map((f) => f.rule)).toEqual(["marketplace-invalid"]);
  });

  it("the command exits 1 on findings, 0 when up to date, 2 without exactly one mode", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await marketplaceCommand(["--check"], root)).toBe(1);
      expect(err.mock.calls.flat().join("\n")).toMatch(
        /\.capybara-plugin\/marketplace\.json:1 marketplace-missing fixture-declarative@0\.1\.0/,
      );
      expect(await marketplaceCommand(["--write", "--root", root], "/")).toBe(0);
      expect(await marketplaceCommand(["--check"], root)).toBe(0);
      expect(await marketplaceCommand([], root)).toBe(2);
      expect(await marketplaceCommand(["--write", "--check"], root)).toBe(2);
    } finally {
      log.mockRestore();
      err.mockRestore();
    }
  }, 60_000);
});
