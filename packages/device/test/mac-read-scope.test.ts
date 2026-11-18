import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecResult } from "@capybara-hq/plugin-sdk";
import { afterAll, beforeAll, expect, it } from "vitest";
import { startMacOperationWorker } from "../src/exec/operation-worker.js";
import { sealWorkspaceRuntime } from "./runtime-seal.js";

const workspace = { runtimeHash: "", cleanup: async () => {} };
let root = "";
let unrelated = "";
beforeAll(async () => {
  if (process.platform !== "darwin") return;
  Object.assign(workspace, await sealWorkspaceRuntime());
  root = await realpath(await mkdtemp(join(tmpdir(), "cap-mac-readscope-")));
  unrelated = await realpath(await mkdtemp(join(tmpdir(), "cap-mac-unrelated-")));
});
afterAll(async () => {
  await workspace.cleanup();
  if (root) await rm(root, { recursive: true, force: true });
  if (unrelated) await rm(unrelated, { recursive: true, force: true });
});

async function restrictedExec(
  command: string,
  home: string | undefined,
  project: string,
  state: string,
) {
  const worker = await startMacOperationWorker(
    {
      kind: "exec",
      scope: { operationId: "read-scope", tag: "read-scope" } as never,
      grant: {
        full: false,
        readRoots: [project],
        writeRoots: [project],
        hosts: [],
        deniedReadRoots: [state],
        revision: "r",
      },
      args: { command, cwd: project, timeoutMs: 60_000, maxOutputBytes: 1 << 16 },
      stateDir: state,
      pythonPath: "/usr/bin/python3",
      runtimeHash: workspace.runtimeHash,
      // no home: the device's own home and environment, as in production
      ...(home ? { toolHome: { home, env: {} } } : {}),
      beforeLaunch: async () => {},
      onLaunch: async () => {},
    },
    new AbortController().signal,
  );
  return (await worker.completion) as ExecResult;
}

// A restricted macOS command reads only its grant, the runtime and system roots and the tool
// homes: a plain file of the home, a file in an unrelated directory beside the project, and a
// listing of the project's ancestors stay out of reach.
it.runIf(process.platform === "darwin")(
  "a restricted macOS command cannot read outside its granted roots",
  async () => {
    const home = join(root, "home");
    const project = join(root, "project");
    const state = join(root, "state");
    await mkdir(home);
    await mkdir(project);
    await mkdir(state, { mode: 0o700 });
    await writeFile(join(home, "outside.txt"), "home secret");
    await writeFile(join(unrelated, "outside.txt"), "unrelated secret");
    await writeFile(join(project, "inside.txt"), "inside");
    const q = (s: string) => JSON.stringify(s);
    const result = await restrictedExec(
      [
        "cat inside.txt > got-inside",
        `cat ${q(join(home, "outside.txt"))} > got-home 2>/dev/null || rm -f got-home`,
        `cat ${q(join(unrelated, "outside.txt"))} > got-unrelated 2>/dev/null || rm -f got-unrelated`,
        `ls ${q(root)} > got-listing 2>/dev/null || rm -f got-listing`,
        "true",
      ].join("; "),
      home,
      project,
      state,
    );
    expect(result.exitCode, result.stderr).toBe(0);
    const got = (name: string) =>
      existsSync(join(project, name)) ? readFileSync(join(project, name), "utf8") : null;
    expect(got("got-inside"), result.stderr).toBe("inside");
    expect(got("got-home"), "a plain file of the home").toBeNull();
    expect(got("got-unrelated"), "a file in an unrelated temp dir").toBeNull();
    expect(got("got-listing"), "the listing of the project's parent").toBeNull();
  },
);

/** What `argv` prints outside any sandbox, or undefined when it does not run on this machine. */
function hostOutput(argv: string[], cwd: string): string | undefined {
  try {
    return execFileSync(argv[0] as string, argv.slice(1), {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 60_000,
    });
  } catch {
    return undefined;
  }
}

// Narrowing reads to the grant must not break an ordinary developer command: each one that runs
// on this machine outside the sandbox prints the same inside a restricted command (git in a
// repository, node, the system python3 and cc shims, which read the Xcode selection, its license
// and the xcrun cache, the time zone, the random device).
it.runIf(process.platform === "darwin")(
  "ordinary developer commands run in a restricted macOS command as they do outside it",
  async () => {
    const project = join(root, "smoke");
    const state = join(root, "smoke-state");
    await mkdir(project);
    await mkdir(state, { mode: 0o700 });
    const git = ["git", "-c", "user.email=a@b", "-c", "user.name=n"];
    hostOutput([...git, "init", "-q"], project);
    hostOutput([...git, "commit", "-q", "--allow-empty", "-m", "init"], project);
    await writeFile(join(project, "a.txt"), "hi");
    const probes: Record<string, string[]> = {
      git: ["git", "status", "--porcelain"],
      node: [process.execPath, "-e", "console.log(process.cwd(), new Date(0).toString())"],
      python: [
        "/usr/bin/python3",
        "-I",
        "-c",
        "import os, ssl, time; print(os.getcwd(), time.tzname)",
      ],
      cc: ["/usr/bin/cc", "--version"],
      ls: ["/bin/ls", "-a"],
      date: ["/bin/date", "-r", "0"],
    };
    const expected = Object.fromEntries(
      Object.entries(probes).map(([name, argv]) => [name, hostOutput(argv, project)]),
    );
    const q = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
    const command = [
      ...Object.entries(probes)
        .filter(([name]) => expected[name] !== undefined)
        .map(([name, argv]) => `${argv.map(q).join(" ")} > out-${name} 2> err-${name}`),
      "head -c 4 /dev/urandom | wc -c | tr -d ' ' > out-urandom",
      "true",
    ].join("; ");
    const result = await restrictedExec(command, undefined, project, state);
    expect(result.exitCode, result.stderr).toBe(0);
    const read = (name: string) =>
      existsSync(join(project, name)) ? readFileSync(join(project, name), "utf8") : null;
    for (const [name, want] of Object.entries(expected)) {
      if (want === undefined) continue;
      let got = read(`out-${name}`);
      // the outputs the command itself wrote into the project
      if (name === "git")
        got = (got ?? "")
          .split("\n")
          .filter((l) => !/ (out|err)-/.test(l))
          .join("\n");
      if (name === "ls") continue;
      expect(got, `${name}: ${read(`err-${name}`)}`).toBe(want);
    }
    expect(read("out-ls"), String(read("err-ls"))).toContain("a.txt");
    expect(read("out-urandom")).toBe("4\n");
  },
);

// The dev loop of a restricted command: a private temporary directory (TMPDIR, TMP and TEMP)
// that it can write, that no other operation shares and that is gone once it ends, so pnpm,
// mktemp and cc work; and git's daily commands in a repository of the write root. `git init`
// and `git worktree add` stay refused by the shared write policy (a documented limitation), so
// the repository is created outside.
it.runIf(process.platform === "darwin")(
  "a restricted macOS command has a private temp dir, and runs pnpm, cc and git's daily loop",
  async () => {
    const project = join(root, "loop");
    const state = join(root, "loop-state");
    await mkdir(project);
    await mkdir(state, { mode: 0o700 });
    const git = ["git", "-c", "user.email=a@b", "-c", "user.name=n"];
    hostOutput([...git, "init", "-q"], project);
    hostOutput([...git, "commit", "-q", "--allow-empty", "-m", "init"], project);
    await writeFile(join(project, "a.txt"), "one\n");
    await writeFile(join(project, "hello.c"), '#include <stdio.h>\nint main(){puts("hello");}\n');
    const pnpm = hostOutput(["pnpm", "--version"], tmpdir());
    const cc = hostOutput(["/usr/bin/cc", "--version"], project) !== undefined;
    const g = "git -c user.email=a@b -c user.name=n";
    const step = (name: string, cmd: string) =>
      `if ${cmd} >/dev/null 2>>errs; then echo ${name} >> steps; else echo "${name} failed" >> errs; fi`;
    const command = [
      'printf "%s\\n%s\\n%s\\n" "$TMPDIR" "$TMP" "$TEMP" > tmp-env',
      // macOS mktemp without a template uses DARWIN_USER_TEMP_DIR whatever TMPDIR says
      step("mktemp", 'f=$(mktemp "$TMPDIR/x.XXXXXX") && echo x > "$f" && test -s "$f"'),
      step("mktemp-d", 'd=$(mktemp -d "$TMPDIR/d.XXXXXX") && touch "$d/x"'),
      step(
        "python-tempfile",
        `/usr/bin/python3 -I -c 'import os, sys, tempfile; tempfile.mkstemp(); sys.exit(tempfile.gettempdir() != os.environ["TMPDIR"])'`,
      ),
      step(
        "node-tmpdir",
        `${process.execPath} -e 'require("fs").mkdtempSync(require("os").tmpdir()+"/x")'`,
      ),
      step("tmp-parent-refused", '! touch "$(dirname "$TMPDIR")/capybara-escape"'),
      ...(pnpm ? ["pnpm --version > out-pnpm 2>>errs"] : []),
      ...(cc ? [step("cc", "/usr/bin/cc hello.c -o hello && ./hello | grep -q hello")] : []),
      step("git-add", `${g} add a.txt hello.c`),
      step("git-commit", `${g} commit -qm one`),
      step("git-checkout-b", `${g} checkout -qb feat`),
      "echo two >> a.txt",
      step("git-stash", `${g} stash push -qm x`),
      step("git-stash-pop", `${g} stash pop -q`),
      step("git-commit-a", `${g} commit -qam two`),
      step("git-init-refused", "! git init -q sub"),
      step("git-worktree-refused", `! ${g} worktree add -q wt`),
      "true",
    ].join("; ");
    const result = await restrictedExec(command, undefined, project, state);
    expect(result.exitCode, result.stderr).toBe(0);
    const read = (name: string) =>
      existsSync(join(project, name)) ? readFileSync(join(project, name), "utf8") : "";
    const steps = read("steps").trim().split("\n");
    for (const name of [
      "mktemp",
      "mktemp-d",
      "python-tempfile",
      "node-tmpdir",
      "tmp-parent-refused",
      ...(cc ? ["cc"] : []),
      "git-add",
      "git-commit",
      "git-checkout-b",
      "git-stash",
      "git-stash-pop",
      "git-commit-a",
      "git-init-refused",
      "git-worktree-refused",
    ])
      expect(steps, `${name}: ${read("errs")}`).toContain(name);
    // the version may differ from the host's: the command has a reduced environment
    if (pnpm) expect(read("out-pnpm"), read("errs")).toMatch(/^\d+\.\d+\.\d+\n$/);
    expect(hostOutput(["git", "log", "--format=%s"], project)).toBe("two\none\ninit\n");
    // one private directory, outside the project, gone after the operation
    const [tmp, tmpVar, temp] = read("tmp-env").trim().split("\n");
    expect(tmp).toBeTruthy();
    expect(tmpVar).toBe(tmp);
    expect(temp).toBe(tmp);
    expect(tmp?.startsWith(project)).toBe(false);
    expect(existsSync(tmp as string)).toBe(false);
    // another operation gets another directory
    const again = await restrictedExec(
      'printf %s "$TMPDIR" > tmp-again',
      undefined,
      project,
      state,
    );
    expect(again.exitCode, again.stderr).toBe(0);
    expect(read("tmp-again")).not.toBe(tmp);
  },
);

// A device that crashed mid-operation leaves its private temporary directory behind: the next
// restricted launch removes those of processes that are gone, never one of a live process.
it.runIf(process.platform === "darwin")(
  "a restricted macOS launch removes the private temp dirs of device processes that are gone",
  async () => {
    const project = join(root, "sweep");
    const state = join(root, "sweep-state");
    await mkdir(project);
    await mkdir(state, { mode: 0o700 });
    // where the worker puts them: the user's temporary directory
    const base = await realpath(
      execFileSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8" }).trim(),
    );
    const gone = spawnSync("/usr/bin/true").pid as number;
    const dead = join(base, `capybara-op-${gone}-test${Date.now()}`);
    const live = join(base, `capybara-op-${process.ppid}-test${Date.now()}`);
    await mkdir(join(dead, "nested"), { recursive: true });
    await mkdir(live);
    try {
      const result = await restrictedExec("true", undefined, project, state);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(existsSync(dead)).toBe(false);
      expect(existsSync(live)).toBe(true);
    } finally {
      await rm(dead, { recursive: true, force: true });
      await rm(live, { recursive: true, force: true });
    }
  },
);
