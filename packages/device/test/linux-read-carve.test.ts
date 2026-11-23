import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxScopeDeniedError } from "@capybara-hq/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type CarveFs,
  carveReadRoots,
  fsNameBytes,
  fsNameString,
  launcherAcceptsRoot,
  MAX_CARVED_READ_ROOTS,
} from "../src/exec/linux-read-carve.js";
import { withCanonicalForms, within } from "../src/exec/operation-types.js";

/**
 * An injected file system: `tree` maps each directory to its entries; an entry that is not a
 * directory of `tree` is a regular file unless `other` gives its type.
 */
function fakeFs(
  tree: Record<string, string[]>,
  opts: { closed?: string[]; other?: Record<string, "link" | "fifo" | "socket"> } = {},
): CarveFs {
  return {
    readdir(path: string): string[] {
      const entries = tree[path];
      if (!entries) throw new Error(`ENOENT ${path}`);
      return entries;
    },
    lstat(path: string) {
      const isDir = path in tree;
      const other = opts.other?.[path];
      return {
        isDirectory: () => isDir,
        isSymbolicLink: () => other === "link",
        isFile: () => !isDir && other === undefined,
      };
    },
    canOpen(path: string): boolean {
      return !(opts.closed ?? []).includes(path);
    },
    canRead(path: string): boolean {
      return !(opts.closed ?? []).includes(path);
    },
  };
}

/** The carved directory roots only. */
function carveDirs(readRoots: readonly string[], denied: readonly string[], fs?: CarveFs) {
  return carveReadRoots(readRoots, denied, fs).roots;
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
    expect(carveDirs([R], [`${R}/a/x`]).sort()).toEqual([`${R}/a/y`, `${R}/b`]);
  });

  it("keeps a root clear of every denied path and drops one inside a denied path", () => {
    expect(carveDirs([`${R}/b`, `${R}/a/x/deep`], [`${R}/a/x`])).toEqual([`${R}/b`]);
  });

  it("drops a root equal to a denied path", () => {
    expect(carveDirs([`${R}/a/x`, `${R}/b`], [`${R}/a/x`])).toEqual([`${R}/b`]);
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
    expect(carveDirs(["/"], ["/home/u/.ssh"], fs)).toEqual(["/home/u/src", "/usr"]);
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
    expect(carveDirs([R], [`${R}/a/x`], fs)).toEqual([`${R}/a/y`]);
  });

  it("never follows a symbolic link", () => {
    // `link` points at `a`, which holds the denied path: neither the link nor its target's
    // contents through the link are granted.
    const roots = carveDirs([R], [`${R}/a/x`]);
    expect(roots.some((r) => r.startsWith(`${R}/link`))).toBe(false);
  });

  it("still carves the ancestors of a denied path that does not exist yet", () => {
    const denied = [`${R}/a/missing/secret`];
    const roots = carveDirs([R], denied);
    expect(roots).toEqual([`${R}/a/x`, `${R}/a/y`, `${R}/b`]);
    assertNoRootTouchesDenied(roots, denied);
  });

  it("dedupes overlapping roots and sorts by code point", () => {
    const roots = carveDirs([`${R}/b`, R, `${R}/b`, `${R}/a`], [`${R}/a/x`]);
    expect(roots).toEqual([`${R}/a/y`, `${R}/b`]);
  });

  it("no returned root contains or sits inside a denied path, and readable dirs stay covered", () => {
    const dirs = [R, `${R}/a`, `${R}/a/x`, `${R}/a/x/deep`, `${R}/a/y`, `${R}/a/y/inner`, `${R}/b`];
    const candidates = [
      ...dirs,
      `${R}/nope/deeper`,
      `${R}/link/y`,
      `${R}/c.txt`,
      `${R}/a/file.txt`,
    ];
    const rootSets = [[R], [R, `${R}/a`], [`${R}/a/y`, `${R}/a/x/deep`]];
    // Every subset of the candidate denied paths, against each set of read roots.
    for (let mask = 0; mask < 1 << candidates.length; mask++) {
      const denied = candidates.filter((_, i) => mask & (1 << i));
      for (const readRoots of rootSets) {
        const { roots, files } = carveReadRoots(readRoots, denied);
        assertNoRootTouchesDenied(roots, denied);
        assertNoRootTouchesDenied(files, denied);
        // Coverage of files: each real regular file under a read root, off every denied path, is
        // granted through a returned root or as an exact file.
        for (const file of [`${R}/c.txt`, `${R}/a/file.txt`]) {
          if (!readRoots.some((r) => within(file, r))) continue;
          if (denied.some((d) => within(d, file) || within(file, d))) continue;
          expect(
            files.includes(file) || roots.some((r) => within(file, r)),
            `${file} unreadable for ${denied}`,
          ).toBe(true);
        }
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
      carveDirs(["/w"], ["/w/secret"], fakeFs(tree));
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
    expect(carveDirs(["/w"], ["/w/secret"], fakeFs(tree))).toHaveLength(MAX_CARVED_READ_ROOTS);
  });

  it("skips names the launcher would refuse as roots, so the launch still starts", () => {
    for (const name of ["back\\slash", "ctl\u0001x", "pct%2Fslash", "pct%5cback", "%2e%2e"])
      mkdirSync(join(R, "a", name));
    expect(carveDirs([R], [`${R}/a/x`])).toEqual([`${R}/a/y`, `${R}/b`]);
  });

  it("grants the regular files directly inside an expanded directory as exact files", () => {
    // R and R/a are expanded (they hold R/a/x); c.txt and a/file.txt sit directly inside them
    expect(carveReadRoots([R], [`${R}/a/x`])).toEqual({
      roots: [`${R}/a/y`, `${R}/b`],
      files: [`${R}/a/file.txt`, `${R}/c.txt`],
    });
    // a root clear of every denied path is kept whole: no file list for it
    expect(carveReadRoots([`${R}/b`], [`${R}/a/x`])).toEqual({ roots: [`${R}/b`], files: [] });
  });

  it("never grants a denied file, given exactly, non-canonically, through a link or in another case", () => {
    const exact = carveReadRoots([R], [`${R}/a/x`, `${R}/a/file.txt`]);
    expect(exact.files).toEqual([`${R}/c.txt`]);
    // a trailing slash and a dot segment
    expect(carveReadRoots([R], [`${R}/a/x`, `${R}/a/./file.txt/`]).files).toEqual([`${R}/c.txt`]);
    // named through the link R/link -> R/a: the canonical form is what the walk meets
    const linked = carveReadRoots([R], withCanonicalForms([`${R}/link/x`, `${R}/link/file.txt`]));
    expect(linked.files).toEqual([`${R}/c.txt`]);
    expect(linked.roots).toEqual([`${R}/a/y`, `${R}/b`]);
    // a case-folding directory would open the file by the denied name (compared lowered)
    expect(carveReadRoots([R], [`${R}/a/x`, `${R}/A/FILE.txt`]).files).toEqual([`${R}/c.txt`]);
    expect(carveReadRoots([R], [`${R}/a/x`, `${R}/a/FILE.TXT`]).files).toEqual([`${R}/c.txt`]);
  });

  it("never grants a symbolic link to a file, a FIFO, a socket or an unreadable file", () => {
    symlinkSync(join(R, "c.txt"), join(R, "a/to-c"));
    writeFileSync(join(R, "a/closed.txt"), "z");
    chmodSync(join(R, "a/closed.txt"), 0o000);
    const real = carveReadRoots([R], [`${R}/a/x`]);
    expect(real.files).toEqual([`${R}/a/file.txt`, `${R}/c.txt`]);
    const fs = fakeFs(
      { "/w": ["secret", "f", "l", "p", "s", "u"], "/w/secret": [] },
      {
        other: { "/w/l": "link", "/w/p": "fifo", "/w/s": "socket" },
        closed: ["/w/u"],
      },
    );
    expect(carveReadRoots(["/w"], ["/w/secret"], fs)).toEqual({ roots: [], files: ["/w/f"] });
  });

  it("leaves a hard-linked file to the agent, which grants it only with one name", () => {
    // The carve sees names, not inodes: the agent's pin refuses a file with a second name, so a
    // hard link to a secret beside a denied path never carries the secret's inode into a rule.
    linkSync(join(R, "c.txt"), join(R, "a/hard.txt"));
    expect(carveReadRoots([R], [`${R}/a/x`]).files).toContain(`${R}/a/hard.txt`);
  });

  it("fills what the directories leave of MAX_CARVED_READ_ROOTS with files and drops the rest", () => {
    const many = Array.from({ length: MAX_CARVED_READ_ROOTS - 1 }, (_, i) => `d${i}`);
    const tree: Record<string, string[]> = {
      "/w": ["secret", ...many, "f1", "f2", "f3"],
      "/w/secret": [],
    };
    for (const m of many) tree[`/w/${m}`] = [];
    const cut = carveReadRoots(["/w"], ["/w/secret"], fakeFs(tree));
    expect(cut.roots).toHaveLength(MAX_CARVED_READ_ROOTS - 1);
    expect(cut.files).toEqual(["/w/f1"]); // code-point order, the rest dropped
    // directories alone above the cap still refuse
    tree["/w"] = ["secret", ...many, "e1", "e2"];
    tree["/w/e1"] = [];
    tree["/w/e2"] = [];
    expect(() => carveReadRoots(["/w"], ["/w/secret"], fakeFs(tree))).toThrow(
      SandboxScopeDeniedError,
    );
  });

  it("compares with denied paths case-insensitively for directories too (only narrows)", () => {
    const fs = fakeFs({
      "/h": ["u"],
      "/h/u": [".SSH", "src", "Notes.TXT"],
      "/h/u/.SSH": ["id"],
      "/h/u/src": [],
    });
    // on a case-folding directory /h/u/.SSH is the denied /h/u/.ssh: neither granted whole nor
    // expanded into its files
    expect(carveReadRoots(["/h"], ["/h/u/.ssh", "/h/u/notes.txt"], fs)).toEqual({
      roots: ["/h/u/src"],
      files: [],
    });
  });
});

describe("launcherAcceptsRoot", () => {
  it("refuses what the SDK launcher's valid_path refuses", () => {
    expect(launcherAcceptsRoot("/home/u/src")).toBe(true);
    expect(launcherAcceptsRoot("/home/u/100%")).toBe(true);
    expect(launcherAcceptsRoot("/home/u/caf%C3%A9")).toBe(true);
    for (const path of [
      "/home/u/a\\b",
      "/home/u/new\nline",
      "/home/u/del\u007f",
      "/home/u/x%2Fy",
      "/home/u/x%5Cy",
      "/home/u/%2E%2e",
      "/home/u/.%2e",
      `/${"a".repeat(4096)}`,
    ])
      expect(launcherAcceptsRoot(path), JSON.stringify(path)).toBe(false);
  });
});

describe("file names as bytes", () => {
  it("reads UTF-8 as text and each other byte as U+DC80-U+DCFF, and back exactly", () => {
    const cases: [number[], string][] = [
      [[0x61, 0x62], "ab"],
      [[0xc3, 0xa9], "é"],
      [[0xf0, 0x90, 0x82, 0x80], "\u{10080}"], // a pair whose low half is in U+DC80-U+DCFF
      [[0x6e, 0xff, 0x6d], "n\udcffm"],
      [[0xc0, 0xaf], "\udcc0\udcaf"], // overlong
      [[0xed, 0xa0, 0x80], "\udced\udca0\udc80"], // an encoded surrogate
      [[0xe2, 0x82, 0x41], "\udce2\udc82A"], // a cut sequence
      [[0xe2, 0xe2, 0x82, 0xac], "\udce2€"],
      [[0xf4, 0x90, 0x80, 0x80], "\udcf4\udc90\udc80\udc80"], // above U+10FFFF
    ];
    for (const [bytes, text] of cases) {
      expect(fsNameString(Uint8Array.from(bytes)), JSON.stringify(text)).toBe(text);
      expect([...fsNameBytes(text)], JSON.stringify(text)).toEqual(bytes);
    }
  });
});
