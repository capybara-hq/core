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
import { repoIconPath } from "../src/marketplace/marketplace.js";
import { packPlugin } from "../src/pack/index.js";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

let root: string;
let file: string;
/** The packs of the two public plugins (name -> integrity), taken before any test runs. */
const integrity = new Map<string, string>();

const DECLARATIVE_EN = "Fixture: a plugin with skills and a connector template and no extension";
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
  // a localized description and a display name: the entry's summary and displayName come from them
  const pj = join(root, "plugins/declarative/.capybara-plugin/plugin.json");
  writeFileSync(
    pj,
    JSON.stringify({
      ...(JSON.parse(readFileSync(pj, "utf8")) as object),
      displayName: { zh: "声明式", en: "Declarative" },
      description: { en: DECLARATIVE_EN, zh: "夹具：带技能和连接器模板、没有扩展的插件" },
    }),
  );
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

  it("--write appends one npm entry per plugin with the pack's sha512, permissions, summary and displayName", async () => {
    const r = await sync(true);
    expect(r.findings).toEqual([]);
    const m = readManifest();
    expect(m.name).toBe(EMPTY.name);
    expect(m.owner).toEqual(EMPTY.owner);
    expect(m.plugins).toEqual([
      {
        name: "fixture-declarative",
        version: "0.1.0",
        summary: { en: DECLARATIVE_EN, zh: "夹具：带技能和连接器模板、没有扩展的插件" },
        displayName: { zh: "声明式", en: "Declarative" },
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
    // a plain string description is the English summary; no displayName in plugin.json, none here
    expect(m.plugins[1]?.summary).toEqual({
      en: "Test fake: an extension tool with a conversation view, a migration, a skill and a connector template",
    });
    expect(m.plugins[1]).not.toHaveProperty("displayName");
    const tools = m.plugins[1] as { permissions: { keys: string[]; sensitive: string[] } };
    expect(tools.permissions.keys).toContain("permissions.tools:write");
    expect(tools.permissions.sensitive).toEqual([
      "permissions.tools:web-only",
      "permissions.tools:write",
    ]);
    expect("errors" in parseMarketplaceManifest(m)).toBe(false);
    // up to date now: --check passes and another --write changes nothing
    expect((await sync(false)).findings).toEqual([]);
    const before = readFileSync(file, "utf8");
    expect((await sync(true)).added).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe(before);
  }, 60_000);

  it("one entry per plugin: --write replaces an older version in place and drops extra versions", async () => {
    await sync(true);
    const m = readManifest();
    const at = (version: string) => ({
      ...(m.plugins[0] as object),
      version,
      source: {
        npm: {
          package: "@capybara-hq/plugin-fixture-declarative",
          version,
          integrity: `sha512-${"A".repeat(86)}==`,
        },
      },
    });
    // the version moved: the old entry is replaced where it stands; a plugin no longer in the tree
    // keeps its entry
    writeManifest({ ...m, plugins: [old2("gone"), at("0.0.9"), m.plugins[1]] });
    const check = await sync(false);
    expect(check.findings.map((f) => [f.rule, f.message.split(" ")[0]])).toEqual([
      ["marketplace-missing", "fixture-declarative@0.1.0"],
    ]);
    expect(check.findings[0]?.message).toContain("0.0.9");
    const r = await sync(true);
    expect(r.findings).toEqual([]);
    expect(r.added.map((e) => `${e.name}@${e.version}`)).toEqual(["fixture-declarative@0.1.0"]);
    expect(r.removed).toEqual(["fixture-declarative@0.0.9"]);
    expect(readManifest().plugins).toEqual([old2("gone"), m.plugins[0], m.plugins[1]]);

    // several versions (the older form): the current one stays, the others go
    writeManifest({ ...m, plugins: [at("0.0.8"), m.plugins[1], m.plugins[0], at("0.0.9")] });
    expect((await sync(false)).findings.map((f) => f.rule)).toEqual(["marketplace-missing"]);
    const w = await sync(true);
    expect(w.added).toEqual([]);
    expect(w.removed).toEqual(["fixture-declarative@0.0.8", "fixture-declarative@0.0.9"]);
    expect(readManifest().plugins).toEqual([m.plugins[0], m.plugins[1]]);
    expect((await sync(false)).findings).toEqual([]);
  }, 60_000);

  it("marketplace-display-stale: --write refreshes summary and displayName of the listed version, nothing else", async () => {
    await sync(true);
    const m = readManifest();
    const stale = structuredClone(m);
    const first = stale.plugins[0] as Record<string, unknown> & {
      source: { npm: { integrity: string } };
    };
    first.summary = { en: "old summary" };
    delete first.displayName;
    // the published bytes: --write never touches the source
    first.source.npm.integrity = `sha512-${"B".repeat(86)}==`;
    writeManifest(stale);
    const check = await sync(false);
    expect(check.findings.map((f) => [f.rule, f.message.split(" ")[0]])).toEqual([
      ["marketplace-display-stale", "fixture-declarative@0.1.0"],
    ]);
    const r = await sync(true);
    expect(r.findings).toEqual([]);
    expect(r.added).toEqual([]);
    expect(r.refreshed).toEqual(["fixture-declarative@0.1.0"]);
    const after = readManifest().plugins[0] as Record<string, unknown>;
    expect(after).toEqual({
      ...first,
      summary: (m.plugins[0] as Record<string, unknown>).summary,
      displayName: { zh: "声明式", en: "Declarative" },
    });
    // the key order of an entry --write writes
    expect(Object.keys(after).slice(0, 4)).toEqual(["name", "version", "summary", "displayName"]);
    expect((await sync(false)).findings).toEqual([]);
  }, 60_000);

  it("icon: --write fills the repository path of the plugin.json icon and refreshes it on a listed entry", async () => {
    const dir = join(root, "plugins/declarative");
    const pj = join(dir, ".capybara-plugin/plugin.json");
    const before = readFileSync(pj, "utf8");
    try {
      mkdirSync(join(dir, "assets"), { recursive: true });
      writeFileSync(join(dir, "assets/icon.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
      writeFileSync(pj, JSON.stringify({ ...JSON.parse(before), icon: "./assets/icon.svg" }));
      // a new entry carries it, right after summary / displayName
      await sync(true);
      const added = readManifest().plugins[0] as Record<string, unknown>;
      expect(added.icon).toBe("./plugins/declarative/assets/icon.svg");
      expect(Object.keys(added).slice(0, 5)).toEqual([
        "name",
        "version",
        "summary",
        "displayName",
        "icon",
      ]);
      const parsed = parseMarketplaceManifest(readManifest());
      expect("errors" in parsed).toBe(false);
      // a listed entry without it (or with another one) is stale; --write sets it again
      const stale = readManifest();
      delete (stale.plugins[0] as Record<string, unknown>).icon;
      writeManifest(stale);
      expect((await sync(false)).findings.map((f) => [f.rule, f.message.split(" ")[0]])).toEqual([
        ["marketplace-display-stale", "fixture-declarative@0.1.0"],
      ]);
      expect((await sync(true)).refreshed).toEqual(["fixture-declarative@0.1.0"]);
      expect((readManifest().plugins[0] as Record<string, unknown>).icon).toBe(
        "./plugins/declarative/assets/icon.svg",
      );
      // plugin.json drops its icon: the entry drops it too
      writeFileSync(pj, before);
      expect((await sync(true)).refreshed).toEqual(["fixture-declarative@0.1.0"]);
      expect(readManifest().plugins[0]).not.toHaveProperty("icon");
    } finally {
      writeFileSync(pj, before);
      await rm(join(dir, "assets"), { recursive: true, force: true });
    }
  }, 60_000);

  it("repoIconPath: a plugin at the repository root and one under plugins/", () => {
    expect(repoIconPath("/r", "/r", "./icon.svg")).toBe("./icon.svg");
    expect(repoIconPath("/r", "/r/plugins/x", "./icons/a.png")).toBe("./plugins/x/icons/a.png");
    expect(repoIconPath("/r", "/r/plugins/x", "icon.svg")).toBe("./plugins/x/icon.svg");
  });

  it("deprecated is set by hand on an entry: --write and --check keep it, a new version has none", async () => {
    await sync(true);
    const m = readManifest();
    const marked = structuredClone(m);
    const first = marked.plugins[0] as Record<string, unknown>;
    first.deprecated = { reason: "Use fixture-declarative 2.x" };
    (marked.plugins[1] as Record<string, unknown>).deprecated = true;
    writeManifest(marked);
    expect((await sync(false)).findings).toEqual([]);
    // a display refresh rewrites the entry: deprecated stays where it was
    first.summary = { en: "old summary" };
    writeManifest(marked);
    const r = await sync(true);
    expect(r.refreshed).toEqual(["fixture-declarative@0.1.0"]);
    const after = readManifest();
    expect(after.plugins[0]?.deprecated).toEqual({ reason: "Use fixture-declarative 2.x" });
    expect(after.plugins[1]?.deprecated).toBe(true);
    expect(after.plugins[0]?.summary).toEqual(m.plugins[0]?.summary);
    const parsed = parseMarketplaceManifest(after);
    expect("errors" in parsed ? parsed.errors : parsed.plugins.map((e) => e.deprecated)).toEqual([
      { reason: "Use fixture-declarative 2.x" },
      true,
    ]);
    // the plugin moved on from a deprecated version: the new version's entry is not deprecated
    const moved = structuredClone(after);
    const old = moved.plugins[0] as Record<string, unknown> & {
      source: { npm: { version: string } };
    };
    old.version = "0.0.9";
    old.source.npm.version = "0.0.9";
    writeManifest(moved);
    await sync(true);
    expect(readManifest().plugins[0]?.version).toBe("0.1.0");
    expect(readManifest().plugins[0]?.deprecated).toBeUndefined();
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

  describe("--base: versions only increase, a published version keeps its integrity", () => {
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

    it("passes when entries are added, reordered, edited in display fields or collapsed", async () => {
      const m = readManifest();
      writeManifest({ ...m, plugins: [m.plugins[1], m.plugins[0], old("later", "9.0.0")] });
      expect((await check()).findings).toEqual([]);
      // a display field edited at a published version: no base rule (only --write's refresh)
      const edited = structuredClone(m);
      (edited.plugins[0] as { summary: { en: string } }).summary.en = "changed";
      writeManifest(edited);
      expect((await check()).findings.map((f) => f.rule)).toEqual(["marketplace-display-stale"]);
    }, 60_000);

    it("deprecating a published version is not an integrity change", async () => {
      const m = readManifest();
      const marked = structuredClone(m);
      (marked.plugins[0] as Record<string, unknown>).deprecated = { reason: "broken" };
      writeManifest(marked);
      expect((await check()).findings).toEqual([]);
    }, 60_000);

    it("marketplace-version-decrease: an entry's version may only increase", async () => {
      const m = readManifest();
      writeManifest({ ...m, plugins: [old("fixture-declarative", "0.0.1"), m.plugins[1]] });
      const f = (await check()).findings.filter((x) => x.rule !== "marketplace-missing");
      expect(f.map((x) => [x.rule, x.message.split(" ")[0]])).toEqual([
        ["marketplace-version-decrease", "fixture-declarative@0.0.1"],
      ]);
      expect(f[0]?.message).toContain("0.1.0");
    }, 60_000);

    it("marketplace-integrity: a version published at the base keeps its integrity", async () => {
      const m = readManifest();
      const changed = structuredClone(m);
      (changed.plugins[0] as { source: { npm: { integrity: string } } }).source.npm.integrity =
        `sha512-${"B".repeat(86)}==`;
      writeManifest(changed);
      const f = (await check()).findings;
      expect(f.map((x) => [x.rule, x.message.split(" ")[0]])).toEqual([
        ["marketplace-integrity", "fixture-declarative@0.1.0"],
      ]);
      expect(f[0]?.message).toContain(integrity.get("fixture-declarative"));
    }, 60_000);

    it("marketplace-version-decrease: moving back to an older version a base in the older form lists", async () => {
      const m = readManifest();
      writeManifest({ ...m, plugins: [old("fixture-declarative", "0.0.9"), ...m.plugins] });
      git("add", "-A");
      git("commit", "-q", "-m", "several versions");
      base = git("rev-parse", "HEAD").trim();
      writeManifest({ ...m, plugins: [old("fixture-declarative", "0.0.9"), m.plugins[1]] });
      const f = (await check()).findings.filter((x) => x.rule !== "marketplace-missing");
      expect(f.map((x) => [x.rule, x.message.split(" ")[0]])).toEqual([
        ["marketplace-version-decrease", "fixture-declarative@0.0.9"],
      ]);
      expect(f[0]?.message).toContain("0.1.0");
    }, 60_000);

    it("a base in the older form (several versions) collapses to one entry without findings", async () => {
      const m = readManifest();
      writeManifest({ ...m, plugins: [old("fixture-declarative", "0.0.9"), ...m.plugins] });
      git("add", "-A");
      git("commit", "-q", "-m", "several versions");
      base = git("rev-parse", "HEAD").trim();
      expect((await check()).findings.map((f) => f.rule)).toEqual(["marketplace-missing"]);
      await sync(true);
      expect(readManifest().plugins).toEqual(m.plugins);
      expect((await check()).findings).toEqual([]);
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
        writeManifest({ ...m, plugins: [old("fixture-declarative", "0.0.1"), m.plugins[1]] });
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
