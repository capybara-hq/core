import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecResult } from "@capybara-hq/plugin-sdk";
import { afterAll, beforeAll, expect, it } from "vitest";
import { withCanonicalForms } from "../src/exec/operation-types.js";
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

/** One restricted macOS operation with `writeRoot` as its only write root (spelled as given). */
async function restrictedRun(writeRoot: string, command: string): Promise<ExecResult> {
  const state = await mkdtemp(join(root, "state-"));
  const worker = await startMacOperationWorker(
    {
      kind: "exec",
      scope: { operationId: "deny", tag: "deny" } as never,
      grant: {
        full: false,
        readRoots: [writeRoot],
        writeRoots: [writeRoot],
        hosts: [],
        deniedReadRoots: [state],
        revision: "r",
      },
      args: { command, cwd: writeRoot, timeoutMs: 60_000, maxOutputBytes: 1 << 16 },
      stateDir: state,
      pythonPath: "/usr/bin/python3",
      runtimeHash: workspace.runtimeHash,
      beforeLaunch: async () => {},
      onLaunch: async () => {},
    },
    new AbortController().signal,
  );
  return (await worker.completion) as ExecResult;
}

// A directory that holds (or may hold) a HEAD git keeps cannot leave .git: moved out, it would be
// a bare-repository lookalike once objects/, refs/ and a config are added beside that HEAD.
it.runIf(process.platform === "darwin")(
  "no directory holding a kept HEAD moves out of .git, and cherry-pick still works",
  async () => {
    const project = join(root, "moves");
    git(root, "init", "-q", "-b", "main", project);
    git(project, "commit", "-q", "--allow-empty", "-m", "init");
    await mkdir(join(project, ".git/modules/sub"), { recursive: true });
    await mkdir(join(project, ".git/worktrees/w"), { recursive: true });
    const result = await restrictedRun(
      project,
      [
        "mkdir -p src",
        "printf 'ref: refs/heads/main' > .git/logs/HEAD; mv .git/logs src/y",
        "mkdir -p .git/refs/remotes/x; printf 'ref: refs/heads/main' > .git/refs/remotes/x/HEAD; mv .git/refs/remotes/x src/x",
        "mv .git/refs/remotes src/r; mv .git/refs src/refs; mv .git/sequencer src/s 2>/dev/null",
        "mv .git/modules/sub src/m; mv .git/worktrees/w src/w",
        'g() { git -c user.name=t -c user.email=t@t "$@"; }',
        "printf a > a && g add a && g commit -qm a && g checkout -qb topic",
        "printf b > b && g add b && g commit -qm b && g checkout -q main && g cherry-pick topic >/dev/null",
        "g log --oneline | wc -l | tr -d ' ' > commits; true",
      ].join("; "),
    );
    expect(readFileSync(join(project, "commits"), "utf8").trim(), result.stderr).toBe("3");
    for (const path of ["src/y", "src/x", "src/r", "src/refs", "src/m", "src/w"])
      expect(existsSync(join(project, path)), path).toBe(false);
    expect(existsSync(join(project, ".git/logs"))).toBe(true);
    expect(existsSync(join(project, ".git/refs/remotes/x/HEAD"))).toBe(true);
  },
);

// Seatbelt matches resolved paths: a root spelled through /tmp (a link to /private/tmp) still gets
// every regex rule. (A root spelled through another symbolic link is not writable at all for the
// runtime's own allow rule: it fails closed; its spellings are covered in mac-write-policy.test.ts.)
it.runIf(process.platform === "darwin")(
  "the policy holds for a root spelled through /tmp",
  async () => {
    const viaTmp = await mkdtemp("/tmp/cap-mac-root-");
    try {
      git(root, "init", "-q", "-b", "main", viaTmp);
      const result = await restrictedRun(
        viaTmp,
        "printf x > .git/unknown; printf x > .BASHRC; printf x > HEAD; printf ok > plain; true",
      );
      expect(existsSync(join(viaTmp, "plain")), result.stderr).toBe(true);
      for (const path of [".git/unknown", ".BASHRC", "HEAD"])
        expect(existsSync(join(viaTmp, path)), path).toBe(false);
    } finally {
      await rm(viaTmp, { recursive: true, force: true });
    }
  },
);

// git keeps working under restricted on macOS: inside a submodule (its gitdir lives in
// .git/modules/<name>), consecutive multi-commit cherry-pick and revert ranges (the sequencer),
// and stash, pack-refs and gc.
it.runIf(process.platform === "darwin")(
  "submodules, sequencer ranges, stash, pack-refs and gc work under restricted",
  async () => {
    const upstream = join(root, "upstream");
    git(root, "init", "-q", "-b", "main", upstream);
    git(upstream, "commit", "-q", "--allow-empty", "-m", "sub-init");
    const project = join(root, "super");
    git(root, "init", "-q", "-b", "main", project);
    git(project, "commit", "-q", "--allow-empty", "-m", "init");
    git(project, "-c", "protocol.file.allow=always", "submodule", "add", "-q", upstream, "sub");
    git(project, "commit", "-q", "-m", "add sub");
    const result = await restrictedRun(
      project,
      [
        "set -e",
        'g() { git -c user.name=t -c user.email=t@t -c gc.auto=0 "$@"; }',
        // inside the submodule: commit, branch, rebase
        "cd sub",
        "printf x > x && g add x && g commit -qm x && g checkout -qb side",
        "printf y > y && g add y && g commit -qm y && g checkout -q main",
        "printf z > z && g add z && g commit -qm z && g checkout -q side && g rebase -q main",
        "g log --oneline | wc -l | tr -d ' ' > ../sub-commits",
        "test ! -e ../.git/modules/sub/index.lock",
        "cd ..",
        "g checkout -qb picks",
        "for n in 1 2 3; do printf $n > p$n && g add p$n && g commit -qm p$n; done",
        "g checkout -q main",
        // stash, pack-refs, gc
        "printf s >> notes.txt && g add notes.txt && g commit -qm local",
        "printf s >> notes.txt && g stash -q && g stash pop -q && g commit -qam s",
        "g pack-refs --all && g gc -q",
        "g log --oneline | wc -l | tr -d ' ' > commits",
        "set +e",
        // the submodule's gitdir still cannot leave .git
        "mkdir -p src; mv .git/modules/sub src/m 2>/dev/null; true",
      ].join("\n"),
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(readFileSync(join(project, "sub-commits"), "utf8").trim(), result.stderr).toBe("4");
    // two consecutive multi-commit ranges and a revert range, each its own restricted command:
    // git cannot remove .git/sequencer itself (it reports so), the worker removes it afterwards
    const g = "git -c user.name=t -c user.email=t@t";
    for (const command of [
      `${g} cherry-pick picks~3..picks~1 >/dev/null 2>&1; true`,
      `${g} cherry-pick picks~1..picks >/dev/null 2>&1; true`,
      `${g} revert --no-edit HEAD~2..HEAD >/dev/null 2>&1; true`,
    ]) {
      await restrictedRun(project, command);
      expect(existsSync(join(project, ".git/sequencer")), command).toBe(false);
    }
    const commits = await restrictedRun(project, "git log --oneline | wc -l | tr -d ' '");
    // init, add sub, notes, the stash commit, three picks, two reverts
    expect(commits.stdout.trim(), commits.stderr).toBe("9");
    expect(existsSync(join(project, "src/m"))).toBe(false);
    expect(existsSync(join(project, ".git/modules/sub/HEAD"))).toBe(true);
  },
);

// The modules and worktrees directories (of the top-level gitdir and of a submodule's) cannot be
// renamed out either: moved out they would carry gitdirs whose configuration is then writable.
it.runIf(process.platform === "darwin")(
  "no modules or worktrees directory moves out of a gitdir",
  async () => {
    const project = join(root, "containers");
    git(root, "init", "-q", "-b", "main", project);
    for (const dir of [
      ".git/modules/sub/modules/inner",
      ".git/modules/sub/worktrees/w",
      ".git/worktrees/w",
    ])
      await mkdir(join(project, dir), { recursive: true });
    const result = await restrictedRun(
      project,
      [
        "mkdir -p src",
        "mv .git/modules/sub/modules src/a",
        "mv .git/modules/sub/worktrees src/b",
        "mv .git/modules src/c",
        "mv .git/worktrees src/d",
        "true",
      ].join("; "),
    );
    for (const path of ["src/a", "src/b", "src/c", "src/d"])
      expect(existsSync(join(project, path)), `${path}: ${result.stderr}`).toBe(false);
  },
);

// A write root that contains a denied directory (a project bound at the home directory, an
// approved `cd ~`): the denied secret paths and the device's state directory stay unwritable,
// their files, the directories themselves (rename, delete) and a symbolic link swapped into
// their place; an ordinary file in the root stays writable.
it.runIf(process.platform === "darwin")(
  "a write root containing a denied directory cannot write, move, delete or swap it",
  async () => {
    const home = await mkdtemp(join(root, "home-"));
    const ssh = join(home, ".ssh");
    const state = join(home, ".config/capybara-device");
    await mkdir(ssh, { recursive: true });
    await mkdir(state, { recursive: true });
    writeFileSync(join(ssh, "authorized_keys"), "orig\n");
    writeFileSync(join(state, "policy.json"), "{}");
    const elsewhere = join(home, "elsewhere");
    await mkdir(elsewhere);
    const tries = [
      "echo pwn >> .ssh/authorized_keys",
      "echo pwn > .ssh/authorized_keys",
      "echo pwn > .ssh/new_key",
      "mv .ssh/authorized_keys .ssh/k2",
      "rm -f .ssh/authorized_keys",
      "mv .ssh .ssh.bak",
      "rm -rf .ssh",
      "mv .ssh elsewhere/ssh",
      "ln -s elsewhere .ssh/link",
      "echo '{\"x\":1}' > .config/capybara-device/policy.json",
      "mv .config/capybara-device/policy.json .config/capybara-device/p2",
      "rm -f .config/capybara-device/policy.json",
      "mv .config/capybara-device .config/cd2",
      "rm -rf .config/capybara-device",
      "mv .config .config2",
      "rm -rf .config",
    ];
    const result = await restrictedRunDenied(
      home,
      [ssh, state],
      [...tries.map((c) => `${c} 2>/dev/null`), "printf ok > plain.txt", "true"].join("; "),
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(readFileSync(join(home, "plain.txt"), "utf8"), result.stderr).toBe("ok");
    expect(readFileSync(join(ssh, "authorized_keys"), "utf8")).toBe("orig\n");
    expect(readFileSync(join(state, "policy.json"), "utf8")).toBe("{}");
    for (const path of [
      ".ssh/new_key",
      ".ssh/k2",
      ".ssh/link",
      ".ssh.bak",
      "elsewhere/ssh",
      ".config/capybara-device/p2",
      ".config/cd2",
      ".config2",
    ])
      expect(existsSync(join(home, path)), path).toBe(false);
    expect(lstatSync(ssh).isDirectory()).toBe(true);
    expect(lstatSync(state).isDirectory()).toBe(true);
    // a symbolic link swapped in place of a denied directory, in a second command once it is gone
    const swap = await restrictedRunDenied(
      home,
      [ssh, state],
      "mv .ssh .ssh-old 2>/dev/null; rm -rf .ssh 2>/dev/null; ln -s elsewhere .ssh 2>/dev/null; true",
    );
    expect(lstatSync(ssh).isDirectory(), swap.stderr).toBe(true);
    expect(readFileSync(join(ssh, "authorized_keys"), "utf8")).toBe("orig\n");
  },
);

/** One restricted macOS operation writing `writeRoot`, with the given owner-denied roots. */
async function restrictedRunDenied(
  writeRoot: string,
  denied: string[],
  command: string,
): Promise<ExecResult> {
  const stateDir = await mkdtemp(join(root, "state-"));
  const worker = await startMacOperationWorker(
    {
      kind: "exec",
      scope: { operationId: "deny", tag: "deny" } as never,
      grant: {
        full: false,
        readRoots: [writeRoot],
        writeRoots: [writeRoot],
        hosts: [],
        deniedReadRoots: withCanonicalForms([...denied, stateDir]),
        revision: "r",
      },
      args: { command, cwd: writeRoot, timeoutMs: 60_000, maxOutputBytes: 1 << 16 },
      stateDir,
      pythonPath: "/usr/bin/python3",
      runtimeHash: workspace.runtimeHash,
      beforeLaunch: async () => {},
      onLaunch: async () => {},
    },
    new AbortController().signal,
  );
  return (await worker.completion) as ExecResult;
}
