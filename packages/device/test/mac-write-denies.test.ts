import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecResult } from "@capybara-hq/plugin-sdk";
import { afterAll, beforeAll, expect, it } from "vitest";
import { startMacOperationWorker } from "../src/exec/operation-worker.js";
import { sealWorkspaceRuntime } from "./runtime-seal.js";

const workspace = { runtimeHash: "", cleanup: async () => {} };
let root = "";
beforeAll(async () => {
  if (process.platform !== "darwin") return;
  Object.assign(workspace, await sealWorkspaceRuntime());
  root = await realpath(await mkdtemp(join(tmpdir(), "cap-mac-denies-")));
});
afterAll(async () => {
  await workspace.cleanup();
  if (root) await rm(root, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);

// The macOS worker expresses the shared SDK write policy (through the patched runtime's ordered
// regex rules): mandatory denies case-insensitively, the gitdir allowlist, no bare-repository
// HEAD, no forged repository in git's subtrees, no nested .git moved away; git keeps working.
it.runIf(process.platform === "darwin")(
  "a restricted macOS command follows the shared write policy while git keeps working",
  async () => {
    const project = join(root, "project");
    const state = join(root, "state");
    await mkdir(project);
    await mkdir(state, { mode: 0o700 });
    git(root, "init", "-q", "-b", "main", project);
    git(project, "commit", "-q", "--allow-empty", "-m", "init");
    await mkdir(join(project, ".git/modules/sub"), { recursive: true });
    await mkdir(join(project, "vendor"));
    git(root, "init", "-q", join(project, "vendor/lib"));
    const worker = await startMacOperationWorker(
      {
        kind: "exec",
        scope: { operationId: "deny", tag: "deny" } as never,
        grant: {
          full: false,
          readRoots: [project],
          writeRoots: [project],
          hosts: [],
          deniedReadRoots: [state],
          revision: "r",
        },
        args: {
          command: [
            "mkdir -p .git/hooks sub/.vscode .claude/commands .husky",
            "printf x > .git/hooks/pre-commit; printf x > .git/commondir; printf x > .git/unknown",
            "mkdir -p .git/info; printf x > .git/info/attributes",
            "printf x > sub/.vscode/settings.json; printf x > .zshrc; printf x > .BASHRC",
            "printf x > .claude/commands/c.md; printf x > .envrc; printf x > .npmrc",
            "printf x > .husky/pre-commit; printf x > lefthook.yml",
            "printf x > .git/modules/sub/config",
            "mkdir -p src/objects src/refs; printf 'ref: refs/heads/main' > src/HEAD; printf x > src/config",
            "mkdir -p .git/objects/zz/.git; printf 'ref: refs/heads/main' > .git/objects/zz/.git/HEAD",
            "mv vendor/lib/.git vendor/lib/g2",
            // ordinary git work: add, commit, branch, checkout, rebase
            'g() { git -c user.name=t -c user.email=t@t "$@"; }',
            "printf a > a && g add a && g commit -qm a",
            "g checkout -qb topic && printf b > b && g add b && g commit -qm b",
            "g checkout -q main && printf c > c && g add c && g commit -qm c",
            "g checkout -q topic && g rebase -q main && g log --oneline | wc -l | tr -d ' ' > commits",
            "printf ok > plain.txt; true",
          ].join("; "),
          cwd: project,
          timeoutMs: 60_000,
          maxOutputBytes: 1 << 16,
        },
        stateDir: state,
        pythonPath: "/usr/bin/python3",
        runtimeHash: workspace.runtimeHash,
        beforeLaunch: async () => {},
        onLaunch: async () => {},
      },
      new AbortController().signal,
    );
    const result = (await worker.completion) as ExecResult;
    expect(result.exitCode, result.stderr).toBe(0);
    expect(existsSync(join(project, "plain.txt"))).toBe(true);
    expect(existsSync(join(project, "commits")), result.stderr).toBe(true);
    // init, a, c (main) plus b rebased onto them
    expect(readFileSync(join(project, "commits"), "utf8").trim(), result.stderr).toBe("4");
    for (const path of [
      ".git/hooks/pre-commit",
      ".git/commondir",
      ".git/unknown",
      ".git/info/attributes",
      "sub/.vscode/settings.json",
      ".zshrc",
      ".BASHRC",
      ".claude/commands/c.md",
      ".envrc",
      ".npmrc",
      ".husky/pre-commit",
      "lefthook.yml",
      ".git/modules/sub/config",
      "src/HEAD",
      ".git/objects/zz/.git/HEAD",
      "vendor/lib/g2",
    ])
      expect(existsSync(join(project, path)), path).toBe(false);
    expect(existsSync(join(project, "vendor/lib/.git/HEAD"))).toBe(true);
  },
);
