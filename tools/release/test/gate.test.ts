import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { releaseGate, runPublish, workspaceAt } from "../src/publish.js";

// A throwaway git repository with a tiny workspace: packages/sdk (public), packages/web (private) and
// one plugin. Every test starts from one commit, "base".
let repo: string;
const git = (...args: string[]) =>
  execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const writePkg = async (dir: string, pkg: Record<string, unknown>) => {
  await mkdir(join(repo, dir), { recursive: true });
  await writeFile(join(repo, dir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
};
const commit = (msg: string) => {
  git("add", "-A");
  git("commit", "-q", "-m", msg);
  return git("rev-parse", "HEAD");
};
const ZERO = "0".repeat(40);

let base: string;
beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "release-gate-"));
  git("init", "-q", "-b", "main");
  git("config", "user.name", "test");
  git("config", "user.email", "test@example.com");
  git("config", "commit.gpgsign", "false");
  await writePkg("packages/sdk", { name: "@t/sdk", version: "0.1.0" });
  await writePkg("packages/web", { name: "@t/web", version: "0.1.0", private: true });
  await writePkg("plugins/chat", { name: "@t/plugin-chat", version: "0.1.0" });
  base = commit("base");
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe("releaseGate", () => {
  it("publishes nothing for an all-zero or unknown previous commit", () => {
    expect(releaseGate(ZERO, { root: repo }).publish).toBe(false);
    expect(releaseGate("1234567890abcdef1234567890abcdef12345678", { root: repo }).publish).toBe(
      false,
    );
  });

  it("opens when a pushed commit changes a published version (a merged Version Packages PR)", async () => {
    await writePkg("plugins/chat", { name: "@t/plugin-chat", version: "0.1.1" });
    commit("chore: version packages");
    const g = releaseGate(base, { root: repo });
    expect(g).toEqual({ publish: true, reason: "@t/plugin-chat@0.1.0 -> 0.1.1" });
  });

  it("stays closed when only a private package changed version", async () => {
    await writePkg("packages/web", { name: "@t/web", version: "0.2.0", private: true });
    commit("private bump");
    expect(releaseGate(base, { root: repo }).publish).toBe(false);
  });

  describe("C1: a push with a pending changeset publishes nothing", () => {
    beforeEach(async () => {
      await mkdir(join(repo, ".changeset"), { recursive: true });
      await writeFile(
        join(repo, ".changeset/brave-otter.md"),
        '---\n"@t/plugin-chat": patch\n---\n\nfix\n',
      );
      commit("fix(chat): something (with a changeset)");
    });

    it("the pushed commit itself changes no version", () => {
      expect(releaseGate(base, { root: repo }).publish).toBe(false);
    });

    it("aborts if `changeset version` rewrote versions in the same checkout (uncommitted)", async () => {
      // What changesets/action does to its working tree before committing to changeset-release/main.
      await writePkg("plugins/chat", { name: "@t/plugin-chat", version: "0.1.1" });
      expect(() => releaseGate(base, { root: repo })).toThrow(/uncommitted package\.json changes/);
    });

    it("aborts if the checkout moved to the version commit (HEAD != the pushed commit)", async () => {
      const pushed = git("rev-parse", "HEAD");
      git("checkout", "-q", "-b", "changeset-release/main");
      await writePkg("plugins/chat", { name: "@t/plugin-chat", version: "0.1.1" });
      commit("chore: version packages");
      expect(() => releaseGate(base, { root: repo, expectedHead: pushed })).toThrow(
        /not the pushed commit/,
      );
    });
  });
});

describe("workspaceAt", () => {
  it("leaves out packages that did not exist at that revision", async () => {
    await writePkg("plugins/new", { name: "@t/plugin-new", version: "0.1.0" });
    commit("add a plugin");
    expect(workspaceAt(base, repo).map((p) => p.name)).toEqual([
      "@t/sdk",
      "@t/web",
      "@t/plugin-chat",
    ]);
    expect(workspaceAt("HEAD", repo).map((p) => p.name)).toContain("@t/plugin-new");
  });

  it("throws for an unknown revision", () => {
    expect(() => workspaceAt("no-such-rev", repo)).toThrow();
  });
});

describe("runPublish", () => {
  it("refuses the first release without packing or publishing anything", async () => {
    const out = join(repo, "out");
    const calls: string[] = [];
    const r = await runPublish({
      dryRun: false,
      provenance: true,
      out,
      root: repo,
      refuseFirstRelease: true,
      publishedVersions: async () => [],
      exec: async (cmd) => {
        calls.push(cmd);
      },
      packPluginTgz: async () => {
        calls.push("pack");
        return "";
      },
    });
    expect(r).toEqual({ published: [], skipped: [] });
    expect(calls).toEqual([]);
    expect(existsSync(out)).toBe(false);
  });

  it("dry run: packs and publishes in plan order with --dry-run, writing checksums as it goes", async () => {
    await writePkg("packages/kernel", { name: "@capybara-hq/kernel", version: "0.1.0" });
    await writePkg("packages/plugin-sdk", { name: "@capybara-hq/plugin-sdk", version: "0.1.0" });
    for (const d of ["packages/kernel", "packages/plugin-sdk", "packages/sdk"]) {
      await mkdir(join(repo, d, "dist"), { recursive: true });
    }
    const out = join(repo, "out");
    const calls: string[] = [];
    const counts: number[] = [];
    const r = await runPublish({
      dryRun: true,
      provenance: false,
      out,
      root: repo,
      // @t/sdk 0.1.0 is already on the registry: skipped.
      publishedVersions: async (name) => (name === "@t/sdk" ? ["0.1.0"] : []),
      exec: async (cmd, args, cwd) => {
        if (cmd === "pnpm") {
          const pkg = JSON.parse(await readFile(join(cwd, "package.json"), "utf8"));
          const file = `${pkg.name.replace(/^@/, "").replace("/", "-")}-${pkg.version}.tgz`;
          await writeFile(join(args[2] as string, file), "lib");
          calls.push(`pack ${pkg.name}`);
        } else calls.push(`${cmd} ${args.filter((a) => a.startsWith("--")).join(" ")}`);
      },
      packPluginTgz: async (dir, o) => {
        const file = join(o, `${dir.split(/[/\\]/).pop()}.tgz`);
        await writeFile(file, "plugin");
        calls.push(`pack-plugin ${file.split(/[/\\]/).pop()}`);
        return file;
      },
      readPackedManifest: () => ({ name: "x", version: "0.1.0" }),
      onPublished: (n) => counts.push(n),
    });
    expect(calls).toEqual([
      "pack @capybara-hq/plugin-sdk",
      "npm --access --dry-run",
      "pack @capybara-hq/kernel",
      "npm --access --dry-run",
      "pack-plugin chat.tgz",
      "npm --access --dry-run",
    ]);
    expect(r.published).toEqual([
      "@capybara-hq/plugin-sdk@0.1.0",
      "@capybara-hq/kernel@0.1.0",
      "@t/plugin-chat@0.1.0",
    ]);
    expect(r.skipped).toEqual(["@t/sdk@0.1.0"]);
    expect(counts).toEqual([1, 2, 3]);
    const sums = await readFile(join(out, "plugins/SHA512SUMS"), "utf8");
    expect(sums).toMatch(/^[0-9a-f]{128} {2}chat\.tgz\n$/);
  });
});
