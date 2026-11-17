import { existsSync } from "node:fs";
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

// The macOS worker applies the same mandatory write denies as the Linux broker (one SDK list).
it.runIf(process.platform === "darwin")(
  "a restricted macOS command cannot write the shared mandatory-deny set",
  async () => {
    const project = join(root, "project");
    const state = join(root, "state");
    await mkdir(project);
    await mkdir(state, { mode: 0o700 });
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
          command:
            "mkdir -p .git/hooks sub/.vscode .claude/commands; printf x > .git/hooks/pre-commit; " +
            "printf x > .git/commondir; printf x > sub/.vscode/settings.json; printf x > .zshrc; " +
            "printf x > .claude/commands/c.md; printf ok > plain.txt; true",
          cwd: project,
          timeoutMs: 20_000,
          maxOutputBytes: 4096,
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
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(project, "plain.txt"))).toBe(true);
    for (const path of [
      ".git/hooks/pre-commit",
      ".git/commondir",
      "sub/.vscode/settings.json",
      ".zshrc",
      ".claude/commands/c.md",
    ])
      expect(existsSync(join(project, path)), path).toBe(false);
  },
);
