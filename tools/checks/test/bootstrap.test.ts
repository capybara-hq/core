import { copyFile, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { packBootstrap } from "@capybara-hq/plugin-tools/pack";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkBootstrap } from "../src/bootstrap.js";

const dir = fileURLToPath(new URL("../fixtures/bootstrap/", import.meta.url));
const fixture = (name: string) => join(dir, name);
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
// Literal paths so the test-plugins check can see which official plugins the repository's
// bootstrap.json makes this test pack.
const PINNED = [
  fileURLToPath(new URL("../../../plugins/openai-compatible", import.meta.url)),
  fileURLToPath(new URL("../../../plugins/object-store-s3", import.meta.url)),
];

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "check-bootstrap-test-"));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/** Copies a fixture manifest into the temp dir (paths still resolve against the fixture root). */
async function copyOf(name: string): Promise<string> {
  const file = join(tmp, name);
  await copyFile(fixture(name), file);
  return file;
}

describe("checkBootstrap", () => {
  it("reports a wrong integrity as bootstrap-stale with the expected value", async () => {
    const f = await checkBootstrap(fixture("stale-integrity.json"), dir);
    expect(f.map((x) => [x.rule, x.line])).toEqual([["bootstrap-stale", 5]]);
    expect(f[0]?.message).toMatch(
      /^demo: integrity is sha512-A+== but plugins\/demo packs sha512-/,
    );
  });

  it("reports a version mismatch as bootstrap-stale", async () => {
    const f = await checkBootstrap(fixture("stale-version.json"), dir);
    expect(f.map((x) => x.rule)).toEqual(["bootstrap-stale", "bootstrap-stale"]);
    expect(f[0]?.message).toContain("version is 9.9.9 but plugins/demo packs 1.2.3");
  });

  it("--write fixes stale entries, after which the manifest is clean", async () => {
    const file = await copyOf("stale-version.json");
    expect(await checkBootstrap(file, dir, { write: true })).toEqual([]);
    const written = JSON.parse(await readFile(file, "utf8"));
    expect(written.plugins[0].version).toBe("1.2.3");
    expect(written.plugins[0].integrity).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/);
    expect(await checkBootstrap(file, dir)).toEqual([]);
  });

  it("the pack is reproducible: two runs pin the same integrity", async () => {
    const a = await copyOf("stale-integrity.json");
    await checkBootstrap(a, dir, { write: true });
    const b = join(tmp, "again.json");
    await copyFile(fixture("stale-integrity.json"), b);
    await checkBootstrap(b, dir, { write: true });
    expect(await readFile(b, "utf8")).toBe(await readFile(a, "utf8"));
  });

  it("reports an entry whose name differs from the packed plugin", async () => {
    const f = await checkBootstrap(fixture("name-mismatch.json"), dir);
    expect(f.map((x) => x.rule)).toEqual(["bootstrap-name"]);
    expect(f[0]?.message).toContain('packs the plugin "demo"');
  });

  it("reports a path that does not pack", async () => {
    const f = await checkBootstrap(fixture("pack-fails.json"), dir);
    expect(f.map((x) => x.rule)).toEqual(["bootstrap-pack"]);
  });

  it("reports a manifest that does not parse", async () => {
    const f = await checkBootstrap(fixture("invalid.json"), dir);
    expect(f.map((x) => x.rule)).toEqual(["bootstrap-invalid"]);
    expect(f[0]?.message).toMatch(/^plugins\.0\.integrity: /);
    const bad = join(tmp, "bad.json");
    await writeFile(bad, "{");
    expect((await checkBootstrap(bad, dir)).map((x) => x.rule)).toEqual(["bootstrap-invalid"]);
  });

  it("leaves npm entries to the network mode", async () => {
    const file = join(tmp, "npm.json");
    const m = JSON.parse(await readFile(fixture("stale-integrity.json"), "utf8"));
    m.marketplace = {
      url: "https://github.com/capybara-hq/plugins.git",
      commit: "0123456789abcdef0123456789abcdef01234567",
    };
    m.plugins = [
      { ...m.plugins[0], source: "npm", npm: "@capybara-hq/plugin-demo", path: undefined },
    ];
    await writeFile(file, JSON.stringify(m));
    expect(await checkBootstrap(file, dir)).toEqual([]);
  });

  it("leaves no temporary files in the fixture", async () => {
    await checkBootstrap(fixture("stale-integrity.json"), dir);
    expect((await readdir(join(dir, "plugins/demo"))).sort()).toEqual([
      ".capybara-plugin",
      "package.json",
      "skills",
    ]);
  });

  it("passes on the repository's bootstrap.json", async () => {
    const manifest = JSON.parse(
      await readFile(join(repoRoot, "packages/kernel/bootstrap.json"), "utf8"),
    );
    expect(manifest.plugins.map((p: { path: string }) => join(repoRoot, p.path))).toEqual(PINNED);
    expect(
      await checkBootstrap(join(repoRoot, "packages/kernel/bootstrap.json"), repoRoot),
    ).toEqual([]);
  }, 60_000);

  it("pnpm pack-bootstrap (plugin-tools' packBootstrap) packs the repository's bootstrap.json as pinned", async () => {
    const r = await packBootstrap(join(repoRoot, "packages/kernel/bootstrap.json"), repoRoot, tmp);
    expect(r.map((p) => p.name).sort()).toEqual(["object-store-s3", "openai-compatible"]);
  }, 120_000);
});
