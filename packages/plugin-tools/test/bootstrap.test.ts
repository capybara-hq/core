import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { packPackageTgz, readBootstrapGitPlugin, readGitTree } from "@capybara-hq/kernel";
import {
  type FakeNpmRegistry,
  startFakeGitServer,
  startFakeNpmRegistry,
} from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readTree } from "../src/bootstrap/check.js";
import { bootstrapCommand } from "../src/bootstrap/cli.js";
import { syncBootstrapExtra } from "../src/bootstrap/index.js";

let root: string;
let file: string;
const sha = (b: Uint8Array) => `sha512-${createHash("sha512").update(b).digest("base64")}`;
const git = (...args: string[]) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
const PLUGIN = "plugins/demo";
const entry = (over: Record<string, unknown> = {}) => ({
  name: "demo",
  source: "git",
  marketplace: "mine",
  commit: "0".repeat(40),
  path: `./${PLUGIN}`,
  version: "0.0.0",
  integrity: `sha512-${"A".repeat(86)}==`,
  ...over,
});
const writeManifest = (plugins: unknown[]) =>
  writeFileSync(
    file,
    JSON.stringify({
      schemaVersion: 1,
      marketplaces: [{ name: "mine", url: "https://git.example.com/org/repo.git" }],
      plugins,
    }),
  );
const read = () => JSON.parse(readFileSync(file, "utf8")) as { plugins: Record<string, string>[] };
const quiet = async <T>(f: () => Promise<T>) => f();

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "bootstrap-extra-"));
  file = join(root, "bootstrap.extra.json");
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("config", "commit.gpgsign", "false");
  mkdirSync(join(root, PLUGIN, ".capybara-plugin"), { recursive: true });
  writeFileSync(
    join(root, PLUGIN, ".capybara-plugin/plugin.json"),
    JSON.stringify({
      schemaVersion: 1,
      name: "demo",
      version: "1.2.3",
      publisher: "T",
      description: "Demo",
    }),
  );
  writeFileSync(join(root, PLUGIN, "README.md"), "hello\n");
  git("add", ".");
  git("commit", "-q", "-m", "plugin");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("capybara-plugin bootstrap", () => {
  it("--write pins commit, version and integrity and writes the pack; --check then passes", async () => {
    writeManifest([entry()]);
    const out = join(root, "packs");
    expect(await quiet(() => bootstrapCommand(["--write", "--out", out], root))).toBe(0);
    const e = read().plugins[0] as Record<string, string>;
    expect(e.commit).toBe(git("rev-parse", "HEAD"));
    expect(e.version).toBe("1.2.3");
    expect(sha(readFileSync(join(out, "demo-1.2.3.tgz")))).toBe(e.integrity);
    expect(await quiet(() => bootstrapCommand(["--check"], root))).toBe(0);
  });

  it("--check reports a changed tree as bootstrap-extra-integrity", async () => {
    writeFileSync(join(root, PLUGIN, "README.md"), "changed\n");
    git("add", ".");
    git("commit", "-q", "-m", "change");
    // the pin still names the old tree: pointing the commit at the new one must now mismatch
    const m = read();
    (m.plugins[0] as Record<string, string>).commit = git("rev-parse", "HEAD");
    writeFileSync(file, JSON.stringify(m));
    const r = await syncBootstrapExtra({ root, file, write: false });
    expect(r.findings.map((f) => f.rule)).toEqual(["bootstrap-extra-integrity"]);
    expect(await quiet(() => bootstrapCommand(["--check"], root))).toBe(1);
  });

  it("--check reports a missing path as bootstrap-extra-path", async () => {
    writeManifest([entry({ commit: git("rev-parse", "HEAD"), path: "./plugins/nope" })]);
    const r = await syncBootstrapExtra({ root, file, write: false });
    expect(r.findings.map((f) => f.rule)).toEqual(["bootstrap-extra-path"]);
  });

  it("--check reports an invalid manifest as bootstrap-extra-invalid", async () => {
    writeFileSync(file, JSON.stringify({ schemaVersion: 1 }));
    const r = await syncBootstrapExtra({ root, file, write: false });
    expect(r.findings.length).toBeGreaterThan(0);
    expect(new Set(r.findings.map((f) => f.rule))).toEqual(new Set(["bootstrap-extra-invalid"]));
  });

  it("needs exactly one of --check and --write", async () => {
    expect(await quiet(() => bootstrapCommand([], root))).toBe(2);
  });
});

/** A fresh local repository with `files` committed (and optionally more set up before it). */
function repoWith(
  files: Record<string, string>,
  before: (dir: string) => void = () => {},
  afterAdd: (dir: string) => void = () => {},
): { dir: string; head: string } {
  const dir = mkdtempSync(join(tmpdir(), "bootstrap-extra-repo-"));
  const g = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" }).trim();
  g("init", "-q");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "t");
  g("config", "commit.gpgsign", "false");
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  before(dir);
  g("add", ".");
  afterAdd(dir);
  g("commit", "-q", "-m", "c");
  return { dir, head: g("rev-parse", "HEAD") };
}

const PLUGIN_JSON = JSON.stringify({
  schemaVersion: 1,
  name: "demo",
  version: "2.0.0",
  publisher: "T",
  description: "Demo",
});

describe("bootstrap git entries: root paths, parity and refusals", () => {
  it("reads a plugin at the repository root (`./`, `.`) with every path intact", async () => {
    // the kernel treats these as the root too (the manifest schema takes `.` and `./`): parity
    const r = repoWith({ ".capybara-plugin/plugin.json": PLUGIN_JSON, "a/b.txt": "x" });
    try {
      for (const path of ["./", ".", ""]) {
        const files = await readTree(r.dir, r.head, path);
        expect([...files.keys()]).toEqual([".capybara-plugin/plugin.json", "a/b.txt"]);
      }
    } finally {
      rmSync(r.dir, { recursive: true, force: true });
    }
  });

  it("--write pins an entry whose path is the repository root", async () => {
    const r = repoWith({ ".capybara-plugin/plugin.json": PLUGIN_JSON, "a/b.txt": "x" });
    try {
      const f = join(r.dir, "bootstrap.extra.json");
      writeFileSync(
        f,
        JSON.stringify({
          schemaVersion: 1,
          marketplaces: [{ name: "mine", url: "https://git.example.com/o/r.git" }],
          plugins: [entry({ path: "." })],
        }),
      );
      expect((await syncBootstrapExtra({ root: r.dir, file: f, write: true })).findings).toEqual(
        [],
      );
      const pinned = JSON.parse(readFileSync(f, "utf8")).plugins[0] as Record<string, string>;
      expect(pinned).toMatchObject({ path: ".", commit: r.head, version: "2.0.0" });
      expect((await syncBootstrapExtra({ root: r.dir, file: f, write: false })).findings).toEqual(
        [],
      );
    } finally {
      rmSync(r.dir, { recursive: true, force: true });
    }
  });

  it("--marketplace reads only that marketplace's git entries from the root", async () => {
    const r = repoWith({ ".capybara-plugin/plugin.json": PLUGIN_JSON });
    try {
      const f = join(r.dir, "bootstrap.extra.json");
      const other = entry({ name: "elsewhere", marketplace: "other", path: "./not/here" });
      writeFileSync(
        f,
        JSON.stringify({
          schemaVersion: 1,
          marketplaces: [
            { name: "mine", url: "https://git.example.com/o/r.git" },
            { name: "other", url: "https://git.example.com/o/other.git" },
          ],
          plugins: [entry({ path: "." }), other],
        }),
      );
      // without it, the other repository's entry is read from this root too: not found
      const all = await syncBootstrapExtra({ root: r.dir, file: f, write: false });
      expect(all.findings.map((x) => x.message)).toEqual(
        expect.arrayContaining([expect.stringContaining("elsewhere: cannot read ./not/here")]),
      );
      const w = await syncBootstrapExtra({
        root: r.dir,
        file: f,
        write: true,
        marketplace: "mine",
      });
      expect(w.findings).toEqual([]);
      expect(w.updated).toEqual(["demo"]);
      const pinned = JSON.parse(readFileSync(f, "utf8")).plugins as Record<string, string>[];
      expect(pinned[0]).toMatchObject({ commit: r.head });
      expect(pinned[1]).toEqual(other);
      expect(
        (await syncBootstrapExtra({ root: r.dir, file: f, write: false, marketplace: "mine" }))
          .findings,
      ).toEqual([]);
      const unknown = await syncBootstrapExtra({
        root: r.dir,
        file: f,
        write: false,
        marketplace: "nope",
      });
      expect(unknown.findings.map((x) => x.message)).toEqual([
        "no marketplace nope in the manifest",
      ]);
    } finally {
      rmSync(r.dir, { recursive: true, force: true });
    }
  });

  it("--write pins Claude Code and skills-only trees at the version the kernel import reads (version parity)", async () => {
    const skill = (n: string) => `---\nname: ${n}\ndescription: Says ${n}\n---\n${n}\n`;
    const trees: Record<string, Record<string, string>> = {
      // a Claude Code plugin with a version: that version
      "claude-x": {
        ".claude-plugin/plugin.json": JSON.stringify({ name: "claude-x", version: "3.1.0" }),
        "skills/hello/SKILL.md": skill("hello"),
      },
      // a Claude Code plugin without one, and a skills-only tree: the entry's own version
      "claude-bare": { "commands/ping.md": "Ping\n", "skills/bare/SKILL.md": skill("bare") },
      "skills-x": { "skills/hi/SKILL.md": skill("hi") },
    };
    const r = repoWith(
      Object.fromEntries(
        Object.entries(trees).flatMap(([name, files]) =>
          Object.entries(files).map(([p, d]) => [`trees/${name}/${p}`, d]),
        ),
      ),
    );
    try {
      const f = join(r.dir, "bootstrap.extra.json");
      const out = join(r.dir, "packs");
      writeFileSync(
        f,
        JSON.stringify({
          schemaVersion: 1,
          marketplaces: [{ name: "mine", url: "https://git.example.com/o/r.git" }],
          plugins: Object.keys(trees).map((name) =>
            entry({ name, path: `./trees/${name}`, version: "0.4.0" }),
          ),
        }),
      );
      const w = await syncBootstrapExtra({ root: r.dir, file: f, write: true, out });
      expect(w.findings).toEqual([]);
      const pinned = JSON.parse(readFileSync(f, "utf8")).plugins as Record<string, string>[];
      expect(pinned.map((e) => [e.name, e.version])).toEqual([
        ["claude-x", "3.1.0"],
        ["claude-bare", "0.4.0"],
        ["skills-x", "0.4.0"],
      ]);
      for (const e of pinned) {
        const files = await readTree(r.dir, r.head, e.path as string);
        // the kernel reads the same version from the same tree (its bootstrap import checks it)
        expect(
          readBootstrapGitPlugin(files, { name: e.name as string, version: "0.4.0" }),
        ).toMatchObject({ name: e.name, version: e.version });
        expect(sha(readFileSync(join(out, `${e.name}-${e.version}.tgz`)))).toBe(e.integrity);
      }
      expect((await syncBootstrapExtra({ root: r.dir, file: f, write: false })).findings).toEqual(
        [],
      );
      // a tree that is another plugin than the entry names is refused
      writeFileSync(
        f,
        JSON.stringify({
          schemaVersion: 1,
          marketplaces: [{ name: "mine", url: "https://git.example.com/o/r.git" }],
          plugins: [entry({ name: "other", path: "./trees/claude-x" })],
        }),
      );
      const bad = await syncBootstrapExtra({ root: r.dir, file: f, write: true });
      expect(bad.findings.map((x) => [x.rule, x.message])).toEqual([
        ["bootstrap-extra-path", "other: ./trees/claude-x: the tree is plugin claude-x, not other"],
      ]);
    } finally {
      rmSync(r.dir, { recursive: true, force: true });
    }
  });

  it("computes the integrity the kernel's git reader and packer give (mapping parity)", async () => {
    const srv = await startFakeGitServer();
    const clone = mkdtempSync(join(tmpdir(), "bootstrap-extra-clone-"));
    try {
      const commit = await srv.commit("o/parity", {
        "README.md": "outside the plugin",
        "plugins/demo/.capybara-plugin/plugin.json": PLUGIN_JSON,
        "plugins/demo/skills/s/SKILL.md": "---\nname: s\n---\nbody\n",
        "plugins/demo/deep/er/file.txt": "nested",
        "plugins/demo/z.txt": "z",
        "plugins/demo-other/x.txt": "sibling with a shared prefix",
      });
      // async: the fake server runs in this process, a sync call would block it
      await promisify(execFile)("git", ["clone", "-q", srv.url("o/parity"), clone]);
      chmodSync(clone, 0o755);
      const f = join(clone, "bootstrap.extra.json");
      writeFileSync(
        f,
        JSON.stringify({
          schemaVersion: 1,
          marketplaces: [{ name: "mine", url: "https://git.example.com/o/r.git" }],
          plugins: [entry({ path: "./plugins/demo" })],
        }),
      );
      expect((await syncBootstrapExtra({ root: clone, file: f, write: true })).findings).toEqual(
        [],
      );
      const pinned = JSON.parse(readFileSync(f, "utf8")).plugins[0] as Record<string, string>;
      expect(pinned.commit).toBe(commit);
      const files = await readGitTree(
        { url: srv.url("o/parity"), commit, path: "./plugins/demo" },
        {
          net: { allowInsecureLoopback: true, allowPrivateHosts: [], trustedOrigins: [] },
          signal: AbortSignal.timeout(60_000),
          maxBytes: 10 * 1024 * 1024,
        },
      );
      expect([...files.keys()]).toContain("deep/er/file.txt");
      expect(pinned.integrity).toBe(sha(await packPackageTgz(files)));
    } finally {
      await srv.stop();
      rmSync(clone, { recursive: true, force: true });
    }
  });

  it("refuses a symlink and a submodule under the plugin path", async () => {
    const link = repoWith({ "p/.capybara-plugin/plugin.json": PLUGIN_JSON }, (d) =>
      symlinkSync("/etc/passwd", join(d, "p/link")),
    );
    const sub = repoWith(
      { "p/.capybara-plugin/plugin.json": PLUGIN_JSON },
      () => {},
      (d) =>
        execFileSync("git", [
          "-C",
          d,
          "update-index",
          "--add",
          "--cacheinfo",
          `160000,${"1".repeat(40)},p/mod`,
        ]),
    );
    try {
      for (const r of [link, sub]) {
        const f = join(r.dir, "bootstrap.extra.json");
        writeFileSync(
          f,
          JSON.stringify({
            schemaVersion: 1,
            marketplaces: [{ name: "mine", url: "https://git.example.com/o/r.git" }],
            plugins: [entry({ path: "./p", commit: r.head })],
          }),
        );
        const res = await syncBootstrapExtra({ root: r.dir, file: f, write: false });
        expect(res.findings.map((x) => x.rule)).toEqual(["bootstrap-extra-path"]);
      }
    } finally {
      rmSync(link.dir, { recursive: true, force: true });
      rmSync(sub.dir, { recursive: true, force: true });
    }
  });
});

describe("bootstrap --network", () => {
  let reg: FakeNpmRegistry;
  const prev = process.env.NPM_CONFIG_REGISTRY;
  const tgz = new Uint8Array([1, 2, 3, 4]);
  beforeAll(async () => {
    reg = await startFakeNpmRegistry({
      packages: [{ name: "@capybara-hq/plugin-x", version: "1.0.0", tgz }],
    });
    process.env.NPM_CONFIG_REGISTRY = reg.url;
  });
  afterAll(async () => {
    if (prev === undefined) delete process.env.NPM_CONFIG_REGISTRY;
    else process.env.NPM_CONFIG_REGISTRY = prev;
    await reg.stop();
  });
  const npm = (integrity: string) => ({
    name: "x",
    source: "npm",
    npm: "@capybara-hq/plugin-x",
    version: "1.0.0",
    integrity,
  });

  it("passes a matching npm entry and reports a mismatching one", async () => {
    writeManifest([npm(sha(tgz))]);
    expect(
      (await syncBootstrapExtra({ root, file, write: false, network: true })).findings,
    ).toEqual([]);
    writeManifest([npm(sha(new Uint8Array([9])))]);
    const r = await syncBootstrapExtra({ root, file, write: false, network: true });
    expect(r.findings.map((f) => f.rule)).toEqual(["bootstrap-extra-integrity"]);
  });
});
