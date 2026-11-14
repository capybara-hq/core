import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FS_HELPER_SCRIPT } from "../src/exec/fs-helper.js";
import { finishScan } from "../src/exec/listing.js";

let base: string;
let root: string;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "device-fs-helper-")));
  root = join(base, "workspace");
  execFileSync("mkdir", ["-p", root]);
  writeFileSync(join(root, "in.txt"), "inside");
  writeFileSync(join(base, "out.txt"), "outside");
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const run = (args: string[], input?: string): { r?: unknown; e?: string; m?: string } => {
  const out = execFileSync(process.execPath, ["-e", FS_HELPER_SCRIPT, ...args], {
    input,
    encoding: "utf8",
  });
  return JSON.parse(out) as { r?: unknown; e?: string; m?: string };
};

const read = (mode: string, path: string, max = 100) =>
  run([mode, "read", path, String(max), root]);

describe("FS_HELPER_SCRIPT", () => {
  it("refuses a missing or unknown mode", () => {
    expect(run(["", "read", join(root, "in.txt"), "100", root])).toMatchObject({ e: "policy" });
    expect(run(["dev", "read", join(root, "in.txt"), "100", root])).toMatchObject({
      e: "policy",
    });
  });

  it("sandbox mode enforces the roots", () => {
    expect(read("sandbox", join(root, "in.txt"))).toEqual({
      r: { b64: Buffer.from("inside").toString("base64"), truncated: false },
    });
    expect(read("sandbox", join(base, "out.txt"))).toMatchObject({ e: "policy" });
    // a link that leaves the root is refused after resolving
    execFileSync("ln", ["-s", join(base, "out.txt"), join(root, "link")]);
    expect(read("sandbox", join(root, "link"))).toMatchObject({ e: "policy" });
  });

  it("auto mode accepts any clean absolute path", () => {
    expect(read("auto", join(base, "out.txt"))).toEqual({
      r: { b64: Buffer.from("outside").toString("base64"), truncated: false },
    });
    expect(read("auto", join(base, "missing"))).toEqual({ r: null });
  });

  it("auto mode still refuses relative paths, .. segments and control characters", () => {
    for (const bad of ["out.txt", `${base}/a/../out.txt`, `${base}/a\u0001b`]) {
      expect(read("auto", bad), JSON.stringify(bad)).toMatchObject({ e: "policy" });
    }
  });

  it("writes in sandbox mode only inside the roots, and in auto anywhere", () => {
    const inside = run(["sandbox", "write", join(root, "w.txt"), "0", root], "hello");
    expect(inside).toEqual({ r: null });
    expect(readFileSync(join(root, "w.txt"), "utf8")).toBe("hello");
    const refused = run(["sandbox", "write", join(base, "escape.txt"), "0", root], "x");
    expect(refused).toMatchObject({ e: "policy" });
    const auto = run(["auto", "write", join(base, "auto.txt"), "0", root], "auto");
    expect(auto).toEqual({ r: null });
    expect(readFileSync(join(base, "auto.txt"), "utf8")).toBe("auto");
  });

  it("stats and refuses non-regular files", () => {
    expect(run(["sandbox", "stat", join(root, "in.txt"), "0", root])).toEqual({
      r: { size: 6, isDir: false },
    });
    execFileSync("mkfifo", [join(root, "fifo")]);
    expect(read("sandbox", join(root, "fifo"))).toMatchObject({ e: "policy" });
  });

  describe("list and scan (sandbox mode: the workspace only)", () => {
    const list = (path: string, limit = 10) => run(["sandbox", "list", path, String(limit), root]);
    const scan = (path: string) => run(["sandbox", "scan", path, "0", root]);

    it("lists a workspace directory sorted by code unit, truncated past the limit", () => {
      mkdirSync(join(root, "B"));
      mkdirSync(join(root, "a"));
      expect(list(root)).toEqual({
        r: {
          entries: [
            { name: "B", isDir: true },
            { name: "a", isDir: true },
            { name: "in.txt", isDir: false },
          ],
          truncated: false,
        },
      });
      expect(list(root, 1)).toEqual({
        r: { entries: [{ name: "B", isDir: true }], truncated: true },
      });
    });

    it("answers null only for a missing path inside the workspace; outside it is refused", () => {
      expect(list(join(root, "missing"))).toEqual({ r: null });
      expect(list(join(base, "missing"))).toMatchObject({ e: "policy" });
      expect(list(base)).toMatchObject({ e: "policy" });
      expect(list(join(root, "in.txt"))).toMatchObject({ e: "error", m: /not a directory/ });
    });

    it("does not follow a link out of the workspace", () => {
      mkdirSync(join(base, "outdir"));
      symlinkSync(join(base, "outdir"), join(root, "out"));
      mkdirSync(join(root, "sub"));
      symlinkSync(join(root, "sub"), join(root, "in"));
      expect(list(join(root, "out"))).toMatchObject({ e: "policy" });
      expect(scan(join(root, "out"))).toMatchObject({ e: "policy" });
      const entries = (list(root).r as { entries: { name: string; isDir: boolean }[] }).entries;
      expect(entries.filter((e) => e.name === "in" || e.name === "out")).toEqual([
        { name: "in", isDir: true },
        { name: "out", isDir: false },
      ]);
    });

    it("scans like scanDirectory: the base, two levels, no hidden or skipped directories", () => {
      for (const d of ["p/.git", "p/sub/.git", "x/y/z/.git", ".h/q/.git", "node_modules/m/.git"]) {
        mkdirSync(join(root, d), { recursive: true });
      }
      mkdirSync(join(base, "elsewhere/.git"), { recursive: true });
      symlinkSync(join(base, "elsewhere"), join(root, "link"));
      writeFileSync(join(root, "AGENTS.md"), "");
      const r = scan(root).r as string[];
      expect(finishScan(r)).toEqual([
        { path: root, suggestedName: "workspace" },
        { path: join(root, "p"), suggestedName: "p" },
        { path: join(root, "p/sub"), suggestedName: "sub" },
      ]);
      expect(scan(join(root, "missing"))).toEqual({ r: [] });
      expect(scan(join(root, "in.txt"))).toMatchObject({ e: "error" });
      expect(scan(base)).toMatchObject({ e: "policy" });
    });
  });
});
