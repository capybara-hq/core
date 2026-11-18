import { execFileSync } from "node:child_process";
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
