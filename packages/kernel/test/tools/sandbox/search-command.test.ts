import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  parseCounts,
  parseFileList,
  parseGrepNull,
} from "../../../src/tools/builtins/sandbox/grep.js";
import {
  ALWAYS_SKIPPED_DIRS,
  type GrepCommandOptions,
  grepCommand,
  listFilesCommand,
} from "../../../src/tools/builtins/sandbox/search-command.js";

/** Grep / Glob commands: ripgrep when the device has it, else grep / find skipping fixed dirs. */

const base: GrepCommandOptions = {
  mode: "files_with_matches",
  pattern: "needle",
  target: ".",
  directory: true,
  numbered: true,
  ignoreCase: false,
  context: {},
};

describe("grepCommand", () => {
  it("prefers ripgrep in the same shell command and falls back to grep", () => {
    const c = grepCommand(base);
    expect(c).toMatch(/^if command -v rg >\/dev\/null 2>&1; then rg .*; else grep .*; fi$/);
    const [rg, grep] = c.split("; else ");
    expect(rg).toContain("--no-config");
    expect(rg).toContain("--hidden");
    expect(rg).toContain("--sort=path");
    expect(rg).toContain("--null");
    expect(rg).toContain(" -l ");
    // never `-I`: in ripgrep it means --no-filename
    expect(rg).not.toMatch(/ -I /);
    for (const d of ALWAYS_SKIPPED_DIRS) {
      expect(rg).toContain(`--glob='!${d}'`);
      expect(grep).toContain(`--exclude-dir='${d}'`);
    }
    expect(grep).toContain("grep -rlIE --null");
    expect(c.endsWith("-e 'needle' -- '.'; fi")).toBe(true);
  });

  it("maps every mode and option to both tools", () => {
    const content = grepCommand({
      ...base,
      mode: "content",
      ignoreCase: true,
      context: { A: 1, B: 2, C: 3 },
      glob: "*.ts",
      pattern: "it's",
    });
    const [rg, grep] = content.split("; else ");
    expect(rg).toContain(" -n --no-heading -i -A 1 -B 2 -C 3 --glob='*.ts' --glob='!.git'");
    expect(grep).toContain("grep -rnHIE --null -i -A 1 -B 2 -C 3 --include='*.ts'");
    expect(content).toContain(`-e 'it'\\''s'`);
    const plain = grepCommand({ ...base, mode: "content", numbered: false });
    expect(plain).toContain(" -N --no-heading");
    expect(plain).toContain("grep -rHIE --null");
    const count = grepCommand({ ...base, mode: "count", context: { A: 4 } });
    expect(count).toContain(" -H -c ");
    expect(count).toContain("grep -rcHIE --null");
    // context only in content mode
    expect(count).not.toContain("-A 4");
  });

  it("searches a single file with grep alone and no directory excludes", () => {
    const c = grepCommand({ ...base, target: "node_modules", directory: false });
    expect(c).toBe("grep -rlIE --null -e 'needle' -- 'node_modules'");
  });
});

describe("listFilesCommand", () => {
  it("lists with ripgrep, else find pruning the skipped directories", () => {
    const c = listFilesCommand();
    expect(c).toContain("then rg --no-config --hidden --glob='!.git'");
    expect(c).toContain("--files --null -- .;");
    expect(c).toContain(
      "else find . \\( -name '.git' -o -name '.hg' -o -name '.svn' -o -name '.jj' -o -name 'node_modules' \\) -prune -o -type f -print0; fi",
    );
  });
});

/** Runs the commands for real on a small tree, once with ripgrep on PATH (when the host has it) and once without. */
describe("on a real tree", () => {
  let root = "";
  let repo = "";
  let noRg = "";
  let withRg = "";
  const which = (cmd: string): string | null => {
    const r = spawnSync("/bin/sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" });
    const p = r.stdout.trim();
    return r.status === 0 && p.startsWith("/") ? p : null;
  };
  const hostRg = which("rg");

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "cap-search-"));
    repo = join(root, "repo");
    const put = (rel: string, text: string) => {
      const p = join(repo, rel);
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, text);
    };
    put("src/a.ts", "const needle = 1;\n");
    put(".github/ci.yml", "needle: true\n");
    put("node_modules/pkg/index.js", "needle\n");
    put(".git/config", "needle\n");
    put("bin.dat", "needle\u0000binary");
    // a tool PATH holding only what the commands need, with and without rg
    noRg = join(root, "bin-no-rg");
    withRg = join(root, "bin-rg");
    for (const dir of [noRg, withRg]) {
      mkdirSync(dir);
      for (const cmd of ["grep", "find"]) {
        const p = which(cmd);
        if (p !== null) symlinkSync(p, join(dir, cmd));
      }
    }
    if (hostRg !== null) symlinkSync(hostRg, join(withRg, "rg"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const run = (command: string, cwd: string, path: string) =>
    spawnSync("/bin/sh", ["-c", command], { cwd, encoding: "utf8", env: { PATH: path } });

  const cases = [
    { name: "without ripgrep", path: () => noRg, skip: false },
    { name: "with ripgrep", path: () => withRg, skip: hostRg === null },
  ];

  for (const c of cases) {
    describe(c.name, () => {
      it.skipIf(c.skip)(
        "Grep skips .git, node_modules and binary files, but searches hidden files",
        () => {
          const r = run(grepCommand(base), repo, c.path());
          expect(r.status).toBe(0);
          expect(parseFileList(r.stdout, "/w").sort()).toEqual([
            "/w/.github/ci.yml",
            "/w/src/a.ts",
          ]);
          const counts = run(grepCommand({ ...base, mode: "count" }), repo, c.path());
          expect(parseCounts(counts.stdout, "/w").sort()).toEqual([
            "/w/.github/ci.yml:1",
            "/w/src/a.ts:1",
          ]);
          const content = run(grepCommand({ ...base, mode: "content" }), repo, c.path());
          expect(parseGrepNull(content.stdout, "/w").sort()).toEqual([
            "/w/.github/ci.yml:1:needle: true",
            "/w/src/a.ts:1:const needle = 1;",
          ]);
        },
      );

      it.skipIf(c.skip)("Grep searches a skipped directory passed explicitly", () => {
        const r = run(grepCommand(base), join(repo, "node_modules"), c.path());
        expect(parseFileList(r.stdout, "/w")).toEqual(["/w/pkg/index.js"]);
      });

      it.skipIf(c.skip)("Glob lists files outside the skipped directories", () => {
        const r = run(listFilesCommand(), repo, c.path());
        expect(
          r.stdout
            .split("\u0000")
            .filter((n) => n !== "")
            .sort(),
        ).toEqual(["./.github/ci.yml", "./bin.dat", "./src/a.ts"]);
        const inside = run(listFilesCommand(), join(repo, "node_modules"), c.path());
        expect(inside.stdout.split("\u0000").filter((n) => n !== "")).toEqual(["./pkg/index.js"]);
      });
    });
  }

  it.skipIf(hostRg === null)("ripgrep also skips what .gitignore ignores", () => {
    const git = join(root, "git-repo");
    mkdirSync(join(git, "dist"), { recursive: true });
    mkdirSync(join(git, "src"));
    // a `.git` directory makes it a repository for ripgrep's .gitignore handling
    mkdirSync(join(git, ".git"));
    writeFileSync(join(git, ".gitignore"), "dist/\n");
    writeFileSync(join(git, "dist/out.js"), "needle\n");
    writeFileSync(join(git, "src/a.ts"), "needle\n");
    const r = run(grepCommand(base), git, withRg);
    expect(parseFileList(r.stdout, "/w")).toEqual(["/w/src/a.ts"]);
    const files = run(listFilesCommand(), git, withRg);
    expect(
      files.stdout
        .split("\u0000")
        .filter((n) => n !== "")
        .sort(),
    ).toEqual(["./.gitignore", "./src/a.ts"]);
    const explicit = run(grepCommand(base), join(git, "dist"), withRg);
    expect(parseFileList(explicit.stdout, "/w")).toEqual(["/w/out.js"]);
  });
});
