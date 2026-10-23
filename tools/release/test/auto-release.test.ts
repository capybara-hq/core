import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertCommittedTree, runPublish } from "../src/publish.js";

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

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "release-gate-"));
  git("init", "-q", "-b", "main");
  git("config", "user.name", "test");
  git("config", "user.email", "test@example.com");
  git("config", "commit.gpgsign", "false");
  await writePkg("packages/sdk", { name: "@t/sdk", version: "0.1.0" });
  await writePkg("packages/web", { name: "@t/web", version: "0.1.0", private: true });
  await writePkg("plugins/chat", { name: "@t/plugin-chat", version: "0.1.0" });
  commit("base");
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

/**
 * An automatic (push) release as the workflow runs it: committed-tree guard, then runPublish with
 * refuseFirstRelease. Records every pack / publish; `registry` maps names to versions on npm.
 */
async function autoRelease(registry: Record<string, string[]>, expectedHead?: string) {
  assertCommittedTree({ root: repo, expectedHead });
  const calls: string[] = [];
  const r = await runPublish({
    dryRun: false,
    provenance: true,
    out: join(repo, "out"),
    root: repo,
    refuseFirstRelease: true,
    publishedVersions: async (name) => registry[name] ?? [],
    exec: async (cmd, args, cwd) => {
      if (cmd === "pnpm") {
        const pkg = JSON.parse(await readFile(join(cwd, "package.json"), "utf8"));
        const file = `${pkg.name.replace(/^@/, "").replace("/", "-")}-${pkg.version}.tgz`;
        await writeFile(join(args[2] as string, file), "lib");
      } else calls.push(`${cmd} ${args[0]} ${(args[1] ?? "").split(/[/\\]/).pop()}`);
    },
    packPluginTgz: async (dir, o) => {
      const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
      const file = join(o, `${pkg.name.replace(/^@/, "").replace("/", "-")}-${pkg.version}.tgz`);
      await writeFile(file, "plugin");
      return file;
    },
    readPackedManifest: () => ({ name: "x", version: "0.1.0" }),
  });
  return { ...r, calls };
}

/** Everything in the base commit is on npm: the first release has happened. */
const RELEASED = { "@t/sdk": ["0.1.0"], "@t/plugin-chat": ["0.1.0"] };

describe("automatic release on push (R8)", () => {
  beforeEach(async () => {
    await mkdir(join(repo, "packages/sdk/dist"), { recursive: true });
  });

  describe("before the first release (P-16)", () => {
    it("refuses the M7 merge (no version change, nothing on npm)", async () => {
      await writeFile(join(repo, "README.md"), "m7\n");
      commit("feat: M7");
      expect(await autoRelease({})).toEqual({ published: [], skipped: [], calls: [] });
      expect(existsSync(join(repo, "out"))).toBe(false);
    });

    it("refuses a pre-release version bump", async () => {
      await writePkg("plugins/chat", { name: "@t/plugin-chat", version: "0.1.1" });
      commit("chore: version packages");
      expect(await autoRelease({})).toEqual({ published: [], skipped: [], calls: [] });
    });
  });

  describe("after the first release", () => {
    it("a pushed changeset commit (no version change) publishes nothing", async () => {
      await mkdir(join(repo, ".changeset"), { recursive: true });
      await writeFile(
        join(repo, ".changeset/brave-otter.md"),
        '---\n"@t/plugin-chat": patch\n---\n\nfix\n',
      );
      const pushed = commit("fix(chat): something (with a changeset)");
      const r = await autoRelease(RELEASED, pushed);
      expect(r.published).toEqual([]);
      expect(r.calls).toEqual([]);
    });

    it("a merged Version Packages PR publishes the new versions", async () => {
      await writePkg("plugins/chat", { name: "@t/plugin-chat", version: "0.1.1" });
      const pushed = commit("chore: version packages");
      const r = await autoRelease(RELEASED, pushed);
      expect(r.published).toEqual(["@t/plugin-chat@0.1.1"]);
      expect(r.calls).toEqual(["npm publish t-plugin-chat-0.1.1.tgz"]);
    });

    it("a run whose predecessor was cancelled still publishes the missed versions", async () => {
      // The Version Packages merge's run was cancelled by the next push's run (one pending run per
      // concurrency group); that next push changes no version, yet its run publishes 0.1.1.
      await writePkg("plugins/chat", { name: "@t/plugin-chat", version: "0.1.1" });
      commit("chore: version packages");
      await writeFile(join(repo, "README.md"), "docs\n");
      const pushed = commit("docs: unrelated");
      const r = await autoRelease(RELEASED, pushed);
      expect(r.published).toEqual(["@t/plugin-chat@0.1.1"]);
    });
  });

  describe("C1: only the committed pushed tree is ever published", () => {
    it("aborts if `changeset version` rewrote versions in the checkout (uncommitted)", async () => {
      await writePkg("plugins/chat", { name: "@t/plugin-chat", version: "0.1.1" });
      await expect(autoRelease(RELEASED)).rejects.toThrow(/uncommitted package\.json changes/);
    });

    it("aborts if the checkout moved to the version commit (HEAD != the pushed commit)", async () => {
      const pushed = git("rev-parse", "HEAD");
      git("checkout", "-q", "-b", "changeset-release/main");
      await writePkg("plugins/chat", { name: "@t/plugin-chat", version: "0.1.1" });
      commit("chore: version packages");
      await expect(autoRelease(RELEASED, pushed)).rejects.toThrow(/not the pushed commit/);
    });
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
