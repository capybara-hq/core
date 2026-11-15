import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEVICE_SCAN_SKIPPED_BASE_DIRS,
  DEVICE_SCAN_SKIPPED_DIRS,
  MAX_DEVICE_SCAN_DIRS,
  MAX_DEVICE_SCAN_RESULTS,
} from "@capybara-hq/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HostExecutor } from "../src/exec/host.js";
import { finishScan, listDirectory, scanDirectory } from "../src/exec/listing.js";
import { DeviceOpError } from "../src/exec/types.js";

let base: string;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "device-listing-")));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

/** Creates the directories `rel` under `base` (and each one's parents). */
const dirs = (...rel: string[]) => {
  for (const r of rel) mkdirSync(join(base, r), { recursive: true });
};
const file = (rel: string, text = "") => {
  mkdirSync(join(base, rel, ".."), { recursive: true });
  writeFileSync(join(base, rel), text);
};
const kindOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof DeviceOpError ? e.kind : "thrown";
  }
};

describe("listDirectory", () => {
  it("sorts entries by code unit and says which are directories", async () => {
    dirs("d/B", "d/a");
    file("d/_x");
    file("d/é");
    expect(await listDirectory(join(base, "d"), 10)).toEqual({
      entries: [
        { name: "B", isDir: true },
        { name: "_x", isDir: false },
        { name: "a", isDir: true },
        { name: "é", isDir: false },
      ],
      truncated: false,
    });
  });

  it("cuts at the limit and says it was truncated", async () => {
    dirs("d/a", "d/b", "d/c");
    expect(await listDirectory(join(base, "d"), 2)).toEqual({
      entries: [
        { name: "a", isDir: true },
        { name: "b", isDir: true },
      ],
      truncated: true,
    });
    expect((await listDirectory(join(base, "d"), 3))?.truncated).toBe(false);
  });

  it("answers null for a missing path and an error for a file", async () => {
    file("f");
    expect(await listDirectory(join(base, "missing"), 10)).toBeNull();
    expect(await listDirectory(join(base, "f/below"), 10)).toBeNull();
    await expect(listDirectory(join(base, "f"), 10)).rejects.toThrow(/not a directory/);
  });

  it("follows symbolic links for isDir: a link to a directory is one, a dangling link is not", async () => {
    dirs("d", "target");
    symlinkSync(join(base, "target"), join(base, "d/link"));
    symlinkSync(join(base, "nowhere"), join(base, "d/dangling"));
    expect((await listDirectory(join(base, "d"), 10))?.entries).toEqual([
      { name: "dangling", isDir: false },
      { name: "link", isDir: true },
    ]);
  });
});

describe("scanDirectory", () => {
  it("finds the base and directories two levels down holding .git or AGENTS.md", async () => {
    dirs("b/.git", "b/one/.git", "b/two/deep", "b/plain/x");
    file("b/two/deep/AGENTS.md");
    file("b/wt/.git", "gitdir: elsewhere");
    dirs("b/two/deep/three/.git"); // three levels down: not looked at
    file("b/agents-dir/x");
    dirs("b/agents-dir/AGENTS.md"); // a directory named AGENTS.md does not count
    expect(await scanDirectory(join(base, "b"))).toEqual([
      { path: join(base, "b"), suggestedName: "b" },
      { path: join(base, "b/one"), suggestedName: "one" },
      { path: join(base, "b/two/deep"), suggestedName: "deep" },
      { path: join(base, "b/wt"), suggestedName: "wt" },
    ]);
  });

  it("keeps descending after a hit (a monorepo's sub-projects are candidates too)", async () => {
    dirs("b/mono/.git", "b/mono/pkg/.git");
    expect((await scanDirectory(join(base, "b"))).map((c) => c.suggestedName)).toEqual([
      "mono",
      "pkg",
    ]);
  });

  it("skips hidden directories, node_modules, Library under the base, and symbolic links", async () => {
    dirs("b/.hidden/p/.git", "b/node_modules/p/.git", "b/x/node_modules/.git");
    dirs("b/Library/p/.git", "b/x/Library/.git", "elsewhere/p/.git");
    symlinkSync(join(base, "elsewhere"), join(base, "b/link"));
    expect(await scanDirectory(join(base, "b"))).toEqual([
      { path: join(base, "b/x/Library"), suggestedName: "Library" },
    ]);
  });

  it("skips a directory whose name breaks the project name rule, never renaming it", async () => {
    dirs("b/ lead/.git", `b/${"n".repeat(65)}/.git`, "b/ok/.git");
    expect((await scanDirectory(join(base, "b"))).map((c) => c.suggestedName)).toEqual(["ok"]);
  });

  it("still walks below a directory whose name breaks the rule", async () => {
    dirs("b/ lead/inner/.git");
    expect(await scanDirectory(join(base, "b"))).toEqual([
      { path: join(base, "b/ lead/inner"), suggestedName: "inner" },
    ]);
  });

  it("skips exactly the SDK's directory lists", async () => {
    for (const n of DEVICE_SCAN_SKIPPED_DIRS) dirs(`b/x/${n}/p/.git`);
    for (const n of DEVICE_SCAN_SKIPPED_BASE_DIRS) dirs(`b/${n}/p/.git`);
    expect(await scanDirectory(join(base, "b"))).toEqual([]);
  });

  it("answers the first 50 by path", async () => {
    for (let i = 0; i < 60; i++) dirs(`b/p${String(i).padStart(2, "0")}/.git`);
    const found = await scanDirectory(join(base, "b"));
    expect(found).toHaveLength(MAX_DEVICE_SCAN_RESULTS);
    expect(found[0]?.suggestedName).toBe("p00");
    expect(found.at(-1)?.suggestedName).toBe("p49");
  });

  it(`reads at most ${MAX_DEVICE_SCAN_DIRS} directories`, async () => {
    for (let i = 0; i < MAX_DEVICE_SCAN_DIRS + 20; i++) dirs(`b/d${String(i).padStart(4, "0")}`);
    dirs("b/a-first/.git", "b/zz-last/.git");
    const found = await scanDirectory(join(base, "b"));
    expect(found.map((c) => c.suggestedName)).toEqual(["a-first"]);
  });

  it("visits each level in code-unit order of path, not parent by parent", async () => {
    // base + 497 directories on the first level leave two visits for the second: by path,
    // "a-x/c" and "a-x/d" come before "a/b" ("-" sorts before "/")
    for (let i = 0; i < MAX_DEVICE_SCAN_DIRS - 5; i++) dirs(`b/f${String(i).padStart(4, "0")}`);
    dirs("b/a/b/.git", "b/a-x/c/.git", "b/a-x/d/.git");
    const found = await scanDirectory(join(base, "b"));
    expect(found.map((c) => c.path)).toEqual([join(base, "b/a-x/c"), join(base, "b/a-x/d")]);
  });

  it("answers [] for a missing base and throws for a file", async () => {
    file("f");
    expect(await scanDirectory(join(base, "missing"))).toEqual([]);
    expect(await kindOf(scanDirectory(join(base, "f")))).toBe("error");
  });

  it("stops when the signal aborts", async () => {
    dirs("b/p/.git");
    const ac = new AbortController();
    ac.abort();
    await expect(scanDirectory(join(base, "b"), { signal: ac.signal })).rejects.toThrow();
  });
});

describe("finishScan", () => {
  it("drops duplicates and paths the protocol refuses, then sorts by code unit", () => {
    expect(finishScan(["/w/b", "/w/a", "/w/b", "/w/a\\b", "/w/B"])).toEqual([
      { path: "/w/B", suggestedName: "B" },
      { path: "/w/a", suggestedName: "a" },
      { path: "/w/b", suggestedName: "b" },
    ]);
  });
});

describe("HostExecutor: list and scan", () => {
  it("reads with the owner's rights in auto mode and refuses a sandbox-mode request", async () => {
    dirs("env", "home/code/core/.git");
    const ex = new HostExecutor({ dir: join(base, "env") });
    const signal = new AbortController().signal;
    expect(await ex.list("auto", join(base, "home/code"), 10)).toEqual({
      entries: [{ name: "core", isDir: true }],
      truncated: false,
    });
    expect(await ex.scan("auto", join(base, "home"), signal)).toEqual([
      { path: join(base, "home/code/core"), suggestedName: "core" },
    ]);
    expect(await kindOf(ex.list("sandbox", join(base, "home"), 10))).toBe("policy");
    expect(await kindOf(ex.scan("sandbox", join(base, "home"), signal))).toBe("policy");
  });
});
