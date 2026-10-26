import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { packedManifestIssues } from "../src/release/publish-plan.js";

// The package as npm ships it: built with tsc (`pnpm build`), packed with `pnpm pack` (the release
// path for libraries), and its bin run with plain node against dist (no tsx, no source condition).

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(pkgDir, "../..");
let out: string;
let tgz: string;

beforeAll(() => {
  execFileSync(join(repo, "node_modules/.bin/tsc"), ["-b", pkgDir], { stdio: "pipe" });
  out = mkdtempSync(join(tmpdir(), "plugin-tools-published-"));
  execFileSync("pnpm", ["pack", "--pack-destination", out], { cwd: pkgDir, stdio: "pipe" });
  const files = readdirSync(out);
  expect(files).toHaveLength(1);
  tgz = join(out, files[0] as string);
}, 180_000);
afterAll(() => {
  rmSync(out, { recursive: true, force: true });
});

describe("the published @capybara-hq/plugin-tools", () => {
  it("packs a manifest the release accepts (no workspace: ranges, no source condition)", () => {
    const manifest = JSON.parse(
      execFileSync("tar", ["-xzOf", tgz, "package/package.json"], { encoding: "utf8" }),
    ) as Record<string, unknown>;
    expect(packedManifestIssues(manifest)).toEqual([]);
    expect(manifest.bin).toEqual({ "capybara-plugin": "./bin/capybara-plugin.mjs" });
  });

  it("ships the bin, dist, README and NOTICE and no sources or tests", () => {
    const entries = execFileSync("tar", ["-tzf", tgz], { encoding: "utf8" }).split("\n");
    for (const f of [
      "package/bin/capybara-plugin.mjs",
      "package/dist/cli.js",
      "package/README.md",
      "package/NOTICE",
    ]) {
      expect(entries).toContain(f);
    }
    expect(entries.some((e) => /^package\/(src|test|fixtures)\//.test(e))).toBe(false);
  });

  it("its bin runs on the compiled dist with plain node", () => {
    const help = execFileSync(
      process.execPath,
      [join(pkgDir, "bin/capybara-plugin.mjs"), "--help"],
      {
        encoding: "utf8",
        env: { ...process.env, NODE_OPTIONS: "" },
      },
    );
    expect(help).toContain("capybara-plugin pack");
    expect(help).toContain("capybara-plugin sync-versions");
  });
});
