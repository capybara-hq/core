import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listSourceFiles } from "../src/check/source.js";

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function put(root: string, path: string, data = "export {};\n"): void {
  const p = join(root, path);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, data);
}

describe("listSourceFiles", () => {
  it("skips the packer staging dirs .capybara-pack-* (at any depth) and lists only plugin sources", () => {
    dir = mkdtempSync(join(tmpdir(), "checks-source-"));
    put(dir, "package.json", "{}");
    put(dir, "src/index.ts");
    put(dir, ".capybara-pack-abc123/package/dist/index.mjs", "process.env.X;\n");
    put(dir, "src/.capybara-pack-x/leftover.ts");
    put(dir, "node_modules/zod/index.js");
    const root = dir;
    expect(listSourceFiles(root).map((f) => relative(root, f.file))).toEqual(["src/index.ts"]);
  });
});
