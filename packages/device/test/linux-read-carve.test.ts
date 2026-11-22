import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxScopeDeniedError } from "@capybara-hq/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { carveReadRoots, MAX_CARVED_READ_ROOTS } from "../src/exec/linux-read-carve.js";
import { within } from "../src/exec/operation-types.js";

/** An injected file system: `tree` maps each directory to its entries (directories only). */
function fakeFs(tree: Record<string, string[]>, opts: { closed?: string[] } = {}) {
  return {
    readdir(path: string): string[] {
      const entries = tree[path];
      if (!entries) throw new Error(`ENOENT ${path}`);
      return entries;
    },
    lstat(path: string) {
      const isDir = path in tree;
      return { isDirectory: () => isDir, isSymbolicLink: () => false };
    },
    canOpen(path: string): boolean {
      return !(opts.closed ?? []).includes(path);
    },
  };
}

function assertNoRootTouchesDenied(roots: readonly string[], denied: readonly string[]) {
  for (const r of roots) {
    for (const d of denied) {
      expect(within(d, r), `${r} contains ${d}`).toBe(false);
      expect(within(r, d), `${r} sits inside ${d}`).toBe(false);
    }
  }
}

describe("carveReadRoots", () => {
  let R: string;

  beforeEach(() => {
    R = realpathSync(mkdtempSync(join(tmpdir(), "carve-")));
    mkdirSync(join(R, "a/x/deep"), { recursive: true });
    mkdirSync(join(R, "a/y/inner"), { recursive: true });
    mkdirSync(join(R, "b"));
    writeFileSync(join(R, "c.txt"), "c");
    writeFileSync(join(R, "a/file.txt"), "f");
    symlinkSync(join(R, "a"), join(R, "link"));
  });

  afterEach(() => {
    rmSync(R, { recursive: true, force: true });
  });

  it("replaces a root holding a denied path with the directories beside it", () => {
    expect(carveReadRoots([R], [`${R}/a/x`]).sort()).toEqual([`${R}/a/y`, `${R}/b`]);
  });

  it("keeps a root clear of every denied path and drops one inside a denied path", () => {
    expect(carveReadRoots([`${R}/b`, `${R}/a/x/deep`], [`${R}/a/x`])).toEqual([`${R}/b`]);
  });

  it("drops a root equal to a denied path", () => {
    expect(carveReadRoots([`${R}/a/x`, `${R}/b`], [`${R}/a/x`])).toEqual([`${R}/b`]);
  });

  it("carves / around the denied paths", () => {
    const fs = fakeFs({
      "/": ["home", "usr"],
      "/home": ["u"],
      "/home/u": [".ssh", "src"],
      "/home/u/.ssh": [],
      "/home/u/src": [],
      "/usr": [],
    });
    expect(carveReadRoots(["/"], ["/home/u/.ssh"], fs)).toEqual(["/home/u/src", "/usr"]);
  });

  it("skips entries it cannot open", () => {
    const fs = fakeFs(
      {
        [R]: ["a", "b"],
        [`${R}/a`]: ["x", "y"],
        [`${R}/a/x`]: [],
        [`${R}/a/y`]: [],
        [`${R}/b`]: [],
      },
      { closed: [`${R}/b`] },
    );
    expect(carveReadRoots([R], [`${R}/a/x`], fs)).toEqual([`${R}/a/y`]);
  });

  it("never follows a symbolic link", () => {
    // `link` points at `a`, which holds the denied path: neither the link nor its target's
    // contents through the link are granted.
    const roots = carveReadRoots([R], [`${R}/a/x`]);
    expect(roots.some((r) => r.startsWith(`${R}/link`))).toBe(false);
  });

  it("still carves the ancestors of a denied path that does not exist yet", () => {
    const denied = [`${R}/a/missing/secret`];
    const roots = carveReadRoots([R], denied);
    expect(roots).toEqual([`${R}/a/x`, `${R}/a/y`, `${R}/b`]);
    assertNoRootTouchesDenied(roots, denied);
  });

  it("dedupes overlapping roots and sorts by code point", () => {
    const roots = carveReadRoots([`${R}/b`, R, `${R}/b`, `${R}/a`], [`${R}/a/x`]);
    expect(roots).toEqual([`${R}/a/y`, `${R}/b`]);
  });

  it("no returned root contains or sits inside a denied path, and readable dirs stay covered", () => {
    const dirs = [R, `${R}/a`, `${R}/a/x`, `${R}/a/x/deep`, `${R}/a/y`, `${R}/a/y/inner`, `${R}/b`];
    const candidates = [...dirs, `${R}/nope/deeper`, `${R}/link/y`, `${R}/c.txt`];
    const rootSets = [[R], [R, `${R}/a`], [`${R}/a/y`, `${R}/a/x/deep`]];
    // Every subset of the candidate denied paths, against each set of read roots.
    for (let mask = 0; mask < 1 << candidates.length; mask++) {
      const denied = candidates.filter((_, i) => mask & (1 << i));
      for (const readRoots of rootSets) {
        const roots = carveReadRoots(readRoots, denied);
        assertNoRootTouchesDenied(roots, denied);
        // Coverage: each real directory under a read root that neither sits inside a denied path
        // nor is an ancestor of one is under some returned root.
        for (const dir of dirs) {
          if (!readRoots.some((r) => within(dir, r))) continue;
          if (denied.some((d) => within(d, dir) || within(dir, d))) continue;
          expect(
            roots.some((r) => within(dir, r)),
            `${dir} uncovered for ${denied}`,
          ).toBe(true);
        }
      }
    }
  });

  it("refuses more than MAX_CARVED_READ_ROOTS roots", () => {
    const many = Array.from({ length: MAX_CARVED_READ_ROOTS + 1 }, (_, i) => `d${i}`);
    const tree: Record<string, string[]> = { "/w": ["secret", ...many], "/w/secret": [] };
    for (const m of many) tree[`/w/${m}`] = [];
    let error: unknown;
    try {
      carveReadRoots(["/w"], ["/w/secret"], fakeFs(tree));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(SandboxScopeDeniedError);
    expect((error as Error).message).toContain("--project-reach paths");
  });

  it("accepts exactly MAX_CARVED_READ_ROOTS roots", () => {
    const many = Array.from({ length: MAX_CARVED_READ_ROOTS }, (_, i) => `d${i}`);
    const tree: Record<string, string[]> = { "/w": ["secret", ...many], "/w/secret": [] };
    for (const m of many) tree[`/w/${m}`] = [];
    expect(carveReadRoots(["/w"], ["/w/secret"], fakeFs(tree))).toHaveLength(MAX_CARVED_READ_ROOTS);
  });
});
