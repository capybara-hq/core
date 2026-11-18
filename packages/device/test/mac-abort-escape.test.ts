import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { startMacOperationWorker } from "../src/exec/operation-worker.js";
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

/** Forks a child that leaves the owned process group, records its pid, and sleeps. */
const ESCAPE = [
  "import os, time",
  "if os.fork() == 0:",
  "    os.setpgid(0, 0)",
  "    open('escaped.tmp', 'w').write(str(os.getpid()))",
  "    os.rename('escaped.tmp', 'escaped')",
  "    time.sleep(120)",
]
  .join("\n")
  .replaceAll("'", `'"'"'`);
const alive = (pid: number) => spawnSync("/bin/kill", ["-0", String(pid)]).status === 0;
async function until(what: string, check: () => boolean): Promise<void> {
  for (let i = 0; i < 600; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

// Found by the Task 14 acceptance run (the permission conformance's cancellation step on the real
// macOS backend). A restricted command's descendant that leaves the owned process group (fork +
// setpgid) is outside what macOS cancellation promises to find (permission operation contract,
// "Explicit background supervision"), but it keeps the command's stdout pipe open: the worker
// waits for the pipe to close, so the aborted call never completes and the worker (with its
// runtime) outlives the device process. The abort must end the call once the owned group is
// gone. `it.fails` records the open bug: drop `.fails` with the fix.
it.runIf(process.platform === "darwin").fails(
  "an aborted restricted command completes although an escaped descendant holds its stdout",
  async () => {
    const project = join(root, "project");
    const state = join(root, "state");
    await mkdir(project);
    await mkdir(state, { mode: 0o700 });
    let main = 0;
    const worker = await startMacOperationWorker(
      {
        kind: "exec",
        scope: { operationId: "abort-escape", tag: "abort-escape" } as never,
        grant: {
          full: false,
          readRoots: [project],
          writeRoots: [project],
          hosts: [],
          deniedReadRoots: [state],
          revision: "r",
        },
        args: {
          command:
            `/usr/bin/python3 -c '${ESCAPE}' & ` +
            "until [ -e escaped ]; do sleep 0.01; done; sleep 1000",
          cwd: project,
          timeoutMs: 120_000,
          maxOutputBytes: 1 << 16,
        },
        stateDir: state,
        pythonPath: "/usr/bin/python3",
        runtimeHash: workspace.runtimeHash,
        beforeLaunch: async () => {},
        onLaunch: async (identity) => {
          main = identity.pid;
        },
      },
      new AbortController().signal,
    );
    let escaped = 0;
    try {
      await worker.ready;
      await until("the escaped descendant", () => existsSync(join(project, "escaped")));
      escaped = Number(readFileSync(join(project, "escaped"), "utf8"));
      let settled = false;
      void worker.completion.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      // the cancellation itself waits for the call: started, not awaited
      const cancelled = worker.cancel("abort").catch(() => {});
      await until("the owned command to end", () => main !== 0 && !alive(main));
      // the owned group is gone; the call must settle without waiting for the escaped process
      await until("the aborted call to complete", () => settled);
      expect(settled).toBe(true);
      await cancelled;
    } finally {
      // the escaped process is the test's to end: it holds the pipe the call waits for
      if (escaped > 0 && alive(escaped)) process.kill(escaped, "SIGKILL");
      void worker.cancel("cleanup").catch(() => {});
      await worker.completion.catch(() => {});
    }
  },
);
