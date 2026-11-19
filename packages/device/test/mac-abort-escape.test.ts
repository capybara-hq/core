import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { type MacWorkerHandle, startMacOperationWorker } from "../src/exec/operation-worker.js";
import { sealWorkspaceRuntime } from "./runtime-seal.js";

const workspace = { runtimeHash: "", cleanup: async () => {} };
let root = "";
beforeAll(async () => {
  if (process.platform !== "darwin") return;
  Object.assign(workspace, await sealWorkspaceRuntime());
  root = await realpath(await mkdtemp(join(tmpdir(), "cap-mac-abort-")));
});
afterAll(async () => {
  await workspace.cleanup();
  if (root) await rm(root, { recursive: true, force: true });
});

const python = (lines: string[]) => lines.join("\n").replaceAll("'", `'"'"'`);
/**
 * Forks a child that leaves the owned process group and records its pid in `name`. With `held`
 * the parent stays in the group and waits for it (the escaped process is still a descendant at
 * abort time); without, the parent exits at once and the child is reparented to launchd.
 */
const escaper = (name: string, held: boolean) =>
  python([
    "import os, time",
    "pid = os.fork()",
    "if pid == 0:",
    "    os.setpgid(0, 0)",
    `    open('${name}.tmp', 'w').write(str(os.getpid()))`,
    `    os.rename('${name}.tmp', '${name}')`,
    "    time.sleep(120)",
    ...(held ? ["else:", "    os.waitpid(pid, 0)"] : []),
  ]);
const alive = (pid: number) => spawnSync("/bin/kill", ["-0", String(pid)]).status === 0;
const parentOf = (pid: number) =>
  Number(spawnSync("/bin/ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" }).stdout);
async function until(what: string, check: () => boolean): Promise<void> {
  for (let i = 0; i < 600; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}
/** This process's private temporary directories of restricted operations still on disk. */
async function privateTemps(): Promise<string[]> {
  const base = spawnSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8" });
  const names = await readdir(await realpath(base.stdout.trim()));
  return names.filter((n) => n.startsWith(`capybara-op-${process.pid}-`));
}
const readPid = (dir: string, name: string) => Number(readFileSync(join(dir, name), "utf8"));
const waitFile = (dir: string, name: string) =>
  until(`the file ${name}`, () => existsSync(join(dir, name)));

interface Launched {
  worker: MacWorkerHandle;
  project: string;
  pid: () => number;
  runtimePid: () => number;
}
async function launch(
  name: string,
  command: string,
  signal: AbortSignal,
  timeoutMs = 120_000,
): Promise<Launched> {
  const project = join(root, name, "project");
  const state = join(root, name, "state");
  await mkdir(project, { recursive: true });
  await mkdir(state, { mode: 0o700 });
  let main = 0;
  let runtime = 0;
  const worker = await startMacOperationWorker(
    {
      kind: "exec",
      scope: { operationId: name, tag: name } as never,
      grant: {
        full: false,
        readRoots: [project],
        writeRoots: [project],
        hosts: [],
        deniedReadRoots: [state],
        revision: "r",
      },
      args: { command, cwd: project, timeoutMs, maxOutputBytes: 1 << 16 },
      stateDir: state,
      pythonPath: "/usr/bin/python3",
      runtimeHash: workspace.runtimeHash,
      beforeLaunch: async () => {},
      onLaunch: async (identity) => {
        main = identity.pid;
      },
      onRuntimeReady: async (info) => {
        runtime = info.pid;
      },
    },
    signal,
  );
  void worker.completion.catch(() => {});
  await worker.ready;
  return { worker, project, pid: () => main, runtimePid: () => runtime };
}
/** The test's own cleanup: whatever is still alive is ended here. */
function sweep(pids: number[]): void {
  for (const pid of pids)
    if (pid > 0 && alive(pid))
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
}

// Found by the Task 14 acceptance run (the permission conformance's cancellation step on the real
// macOS backend). A restricted command's descendant that leaves the owned process group (fork +
// setpgid) keeps the command's stdout pipe open. The abort stops the command's descendants it can
// still find by parent pid (one already reparented to launchd is outside the macOS promise) and,
// once the owned group is gone, closes the pipes after a short grace: the call completes, the
// worker (with its runtime and proxy) ends, and nothing waits for the escaped processes.
it.runIf(process.platform === "darwin")(
  "an aborted restricted command completes and kills its escaped descendants",
  async () => {
    const abort = new AbortController();
    const { worker, project, pid, runtimePid } = await launch(
      "abort-escape",
      `/usr/bin/python3 -c '${escaper("held", true)}' & ` +
        `/usr/bin/python3 -c '${escaper("orphan", false)}' & ` +
        "until [ -e held ] && [ -e orphan ]; do sleep 0.01; done; sleep 1000",
      abort.signal,
    );
    const pids: number[] = [];
    try {
      await waitFile(project, "held");
      await waitFile(project, "orphan");
      const held = readPid(project, "held");
      const orphan = readPid(project, "orphan");
      pids.push(held, orphan, runtimePid());
      // the orphan's parent exited: it already belongs to launchd before the abort
      await until("the orphan to be reparented", () => parentOf(orphan) === 1);
      expect(alive(held)).toBe(true);
      expect(parentOf(held)).not.toBe(1);
      const started = Date.now();
      abort.abort(new Error("aborted by the test"));
      const result = await worker.completion;
      const elapsed = Date.now() - started;
      expect(result).toMatchObject({ exitCode: null, timedOut: false });
      expect(elapsed).toBeLessThan(10_000);
      expect(alive(pid())).toBe(false);
      // the worker process ended with the call
      expect(runtimePid()).toBeGreaterThan(0);
      expect(alive(runtimePid())).toBe(false);
      expect(await privateTemps()).toEqual([]);
      // the escaped descendant that was still a descendant at abort time is killed
      await until("the held escaped process to end", () => !alive(held));
    } finally {
      sweep(pids);
      void worker.cancel("cleanup").catch(() => {});
      await worker.completion.catch(() => {});
    }
  },
);

it.runIf(process.platform === "darwin")(
  "an aborted restricted command never kills a sibling operation's or an unrelated process",
  async () => {
    const abortA = new AbortController();
    const abortB = new AbortController();
    const unrelated = spawn("/bin/sleep", ["120"], { stdio: "ignore" });
    const a = await launch(
      "sibling-a",
      `/usr/bin/python3 -c '${escaper("held", true)}' & until [ -e held ]; do sleep 0.01; done; sleep 1000`,
      abortA.signal,
    );
    const b = await launch(
      "sibling-b",
      `/usr/bin/python3 -c '${escaper("held", true)}' & until [ -e held ]; do sleep 0.01; done; sleep 1000`,
      abortB.signal,
    );
    const pids: number[] = [unrelated.pid ?? 0];
    try {
      await waitFile(a.project, "held");
      await waitFile(b.project, "held");
      const heldA = readPid(a.project, "held");
      const heldB = readPid(b.project, "held");
      pids.push(heldA, heldB);
      abortA.abort(new Error("aborted by the test"));
      await a.worker.completion;
      await until("operation A's escaped process to end", () => !alive(heldA));
      expect(alive(b.pid())).toBe(true);
      expect(alive(heldB)).toBe(true);
      expect(alive(b.runtimePid())).toBe(true);
      expect(alive(unrelated.pid ?? 0)).toBe(true);
      abortB.abort(new Error("aborted by the test"));
      await b.worker.completion;
      await until("operation B's escaped process to end", () => !alive(heldB));
      expect(alive(unrelated.pid ?? 0)).toBe(true);
    } finally {
      unrelated.kill("SIGKILL");
      sweep(pids);
      for (const { worker } of [a, b]) {
        void worker.cancel("cleanup").catch(() => {});
        await worker.completion.catch(() => {});
      }
    }
  },
);

// Darwin's kill(-pgid) fails with EPERM, not ESRCH, while the group holds only dead members.
// Under load the processes an abort killed stay zombies until launchd reaps them, so the group
// signal after the command's exit saw EPERM: the call failed ("Owned group cleanup pending:
// EPERM"), or the worker's own stop failed the same way and the call never completed. Here a
// zombie stays in the group for as long as the test wants: its parent left the group and never
// reaps it.
it.runIf(process.platform === "darwin")(
  "a restricted command whose group holds only an unreaped zombie at exit completes",
  async () => {
    const zombieMaker = python([
      "import os, time",
      "r, w = os.pipe()",
      "if os.fork() == 0:",
      "    os._exit(0)",
      "os.close(w)",
      "os.setpgid(0, 0)",
      "os.read(r, 1)",
      "open('parent.tmp', 'w').write(str(os.getpid()))",
      "os.rename('parent.tmp', 'parent')",
      "time.sleep(120)",
    ]);
    const { worker, project, runtimePid } = await launch(
      "zombie-group",
      `/usr/bin/python3 -c '${zombieMaker}' >/dev/null 2>&1 & until [ -e parent ]; do sleep 0.01; done`,
      new AbortController().signal,
    );
    const pids: number[] = [runtimePid()];
    try {
      await waitFile(project, "parent");
      pids.push(readPid(project, "parent"));
      expect(await worker.completion).toMatchObject({ exitCode: 0, timedOut: false });
      expect(alive(runtimePid())).toBe(false);
    } finally {
      sweep(pids);
      void worker.cancel("cleanup").catch(() => {});
      await worker.completion.catch(() => {});
    }
  },
);

it.runIf(process.platform === "darwin")(
  "a timed-out restricted command completes although a process reparented to launchd holds its stdout",
  async () => {
    // the command itself exits at once; only the escaped process holds the pipe, until the timeout
    const { worker, project, runtimePid } = await launch(
      "timeout-escape",
      `/usr/bin/python3 -c '${escaper("orphan", false)}' & until [ -e orphan ]; do sleep 0.01; done`,
      new AbortController().signal,
      1500,
    );
    const pids: number[] = [runtimePid()];
    try {
      await waitFile(project, "orphan");
      pids.push(readPid(project, "orphan"));
      const result = await worker.completion;
      expect(result).toMatchObject({ exitCode: null, timedOut: true });
      expect(alive(runtimePid())).toBe(false);
    } finally {
      sweep(pids);
      void worker.cancel("cleanup").catch(() => {});
      await worker.completion.catch(() => {});
    }
  },
);
