import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
    JSON.stringify({ schemaVersion: 1, name: "demo", version: "1.2.3", publisher: "T" }),
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
