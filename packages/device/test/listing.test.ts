import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_DEVICE_SCAN_RESULTS } from "@capybara-hq/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DockerExecutor } from "../src/exec/docker.js";
import { HostExecutor } from "../src/exec/host.js";
import {
  finishScan,
  listDirectory,
  MAX_SCAN_DIRS,
  type ReadArea,
  scanDirectory,
} from "../src/exec/listing.js";
import { DeviceOpError } from "../src/exec/types.js";
import { DEFAULT_POLICY } from "../src/state.js";

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
const anyPath: ReadArea = {};
const within = (rel: string): ReadArea => ({
  root: { path: join(base, rel), describe: "the device's workspace" },
});
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
    expect(await listDirectory(join(base, "d"), 10, anyPath)).toEqual({
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
    expect(await listDirectory(join(base, "d"), 2, anyPath)).toEqual({
      entries: [
        { name: "a", isDir: true },
        { name: "b", isDir: true },
      ],
      truncated: true,
    });
    expect((await listDirectory(join(base, "d"), 3, anyPath))?.truncated).toBe(false);
  });

  it("answers null for a missing path and an error for a file", async () => {
    file("f");
    expect(await listDirectory(join(base, "missing"), 10, anyPath)).toBeNull();
    expect(await listDirectory(join(base, "f/below"), 10, anyPath)).toBeNull();
    await expect(listDirectory(join(base, "f"), 10, anyPath)).rejects.toThrow(/not a directory/);
  });

  it("follows symbolic links for isDir: a link to a directory is one, a dangling link is not", async () => {
    dirs("d", "target");
    symlinkSync(join(base, "target"), join(base, "d/link"));
    symlinkSync(join(base, "nowhere"), join(base, "d/dangling"));
    expect((await listDirectory(join(base, "d"), 10, anyPath))?.entries).toEqual([
      { name: "dangling", isDir: false },
      { name: "link", isDir: true },
    ]);
  });

  it("inside an area refuses a path outside it, also a missing one and one a link leads out", async () => {
    dirs("ws/sub", "outside");
    symlinkSync(join(base, "outside"), join(base, "ws/out"));
    symlinkSync(join(base, "ws/sub"), join(base, "ws/in"));
    const area = within("ws");
    expect(await kindOf(listDirectory(join(base, "outside"), 10, area))).toBe("policy");
    expect(await kindOf(listDirectory(join(base, "nothing"), 10, area))).toBe("policy");
    expect(await kindOf(listDirectory(join(base, "ws/out"), 10, area))).toBe("policy");
    expect(await listDirectory(join(base, "ws/nothing"), 10, area)).toBeNull();
    // a link whose target leaves the area is not reported as a directory
    expect((await listDirectory(join(base, "ws"), 10, area))?.entries).toEqual([
      { name: "in", isDir: true },
      { name: "out", isDir: false },
      { name: "sub", isDir: true },
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
    expect(await scanDirectory(join(base, "b"), anyPath)).toEqual([
      { path: join(base, "b"), suggestedName: "b" },
      { path: join(base, "b/one"), suggestedName: "one" },
      { path: join(base, "b/two/deep"), suggestedName: "deep" },
      { path: join(base, "b/wt"), suggestedName: "wt" },
    ]);
  });

  it("keeps descending after a hit (a monorepo's sub-projects are candidates too)", async () => {
    dirs("b/mono/.git", "b/mono/pkg/.git");
    expect((await scanDirectory(join(base, "b"), anyPath)).map((c) => c.suggestedName)).toEqual([
      "mono",
      "pkg",
    ]);
  });

  it("skips hidden directories, node_modules, Library under the base, and symbolic links", async () => {
    dirs("b/.hidden/p/.git", "b/node_modules/p/.git", "b/x/node_modules/.git");
    dirs("b/Library/p/.git", "b/x/Library/.git", "elsewhere/p/.git");
    symlinkSync(join(base, "elsewhere"), join(base, "b/link"));
    expect(await scanDirectory(join(base, "b"), anyPath)).toEqual([
      { path: join(base, "b/x/Library"), suggestedName: "Library" },
    ]);
  });

  it("skips a directory whose name breaks the project name rule, never renaming it", async () => {
    dirs("b/ lead/.git", `b/${"n".repeat(65)}/.git`, "b/ok/.git");
    expect((await scanDirectory(join(base, "b"), anyPath)).map((c) => c.suggestedName)).toEqual([
      "ok",
    ]);
  });

  it("answers the first 50 by path", async () => {
    for (let i = 0; i < 60; i++) dirs(`b/p${String(i).padStart(2, "0")}/.git`);
    const found = await scanDirectory(join(base, "b"), anyPath);
    expect(found).toHaveLength(MAX_DEVICE_SCAN_RESULTS);
    expect(found[0]?.suggestedName).toBe("p00");
    expect(found.at(-1)?.suggestedName).toBe("p49");
  });

  it(`reads at most ${MAX_SCAN_DIRS} directories`, async () => {
    for (let i = 0; i < MAX_SCAN_DIRS + 20; i++) dirs(`b/d${String(i).padStart(4, "0")}`);
    dirs("b/a-first/.git", "b/zz-last/.git");
    const found = await scanDirectory(join(base, "b"), anyPath);
    expect(found.map((c) => c.suggestedName)).toEqual(["a-first"]);
  });

  it("answers [] for a missing base and throws for a file", async () => {
    file("f");
    expect(await scanDirectory(join(base, "missing"), anyPath)).toEqual([]);
    expect(await kindOf(scanDirectory(join(base, "f"), anyPath))).toBe("error");
  });

  it("inside an area refuses a base outside it and maps candidates to reportAs", async () => {
    dirs("ws/p/.git", "outside/.git");
    expect(await kindOf(scanDirectory(join(base, "outside"), within("ws")))).toBe("policy");
    expect(await scanDirectory(join(base, "ws"), within("ws"), { reportAs: "/workspace" })).toEqual(
      [{ path: "/workspace/p", suggestedName: "p" }],
    );
  });

  it("stops when the signal aborts", async () => {
    dirs("b/p/.git");
    const ac = new AbortController();
    ac.abort();
    await expect(scanDirectory(join(base, "b"), anyPath, { signal: ac.signal })).rejects.toThrow();
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

describe("DockerExecutor: list and scan of the container's workspace", () => {
  let ex: DockerExecutor;
  const signal = new AbortController().signal;
  beforeEach(() => {
    dirs("env/workspace/proj/.git", "env/workspace/proj/src", "host-secret/.git");
    symlinkSync(join(base, "host-secret"), join(base, "env/workspace/leak"));
    // no container is needed: the workspace is read through the host directory mounted there
    ex = new DockerExecutor({
      dir: join(base, "env"),
      deviceId: "d1",
      policy: () => DEFAULT_POLICY,
    });
  });

  it("lists and scans the workspace at its container paths, in either mode", async () => {
    for (const mode of ["auto", "sandbox"] as const) {
      expect(await ex.list(mode, "/workspace", 10)).toEqual({
        entries: [
          { name: "leak", isDir: false },
          { name: "proj", isDir: true },
        ],
        truncated: false,
      });
      expect(await ex.scan(mode, "/workspace", signal)).toEqual([
        { path: "/workspace/proj", suggestedName: "proj" },
      ]);
    }
    expect(await ex.list("auto", "/workspace/proj/none", 10)).toBeNull();
  });

  it("refuses anything outside the workspace, also through a link", async () => {
    for (const path of ["/", "/etc", "/skills", "/tmp", "/workspace/../etc", "/workspace/leak"]) {
      expect(await kindOf(ex.list("auto", path, 10)), path).toBe("policy");
    }
    expect(await kindOf(ex.scan("auto", "/home", signal))).toBe("policy");
    await expect(ex.list("auto", "/etc", 10)).rejects.toThrow(/container's workspace/);
    // the message names the container path, never the host directory behind it
    await expect(ex.list("auto", "/workspace/leak", 10)).rejects.not.toThrow(base);
  });
});
