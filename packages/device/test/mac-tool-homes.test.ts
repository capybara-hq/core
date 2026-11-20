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
beforeAll(async () => {
  if (process.platform !== "darwin") return;
  Object.assign(workspace, await sealWorkspaceRuntime());
  root = await realpath(await mkdtemp(join(tmpdir(), "cap-mac-toolhome-")));
});
afterAll(async () => {
  await workspace.cleanup();
  if (root) await rm(root, { recursive: true, force: true });
});

// A restricted macOS command finds its version managers under the real home (a temp home here):
// their data directory and asdf's global .tool-versions are readable, never writable, and an
// owner-denied path of the home, like a plain file of the home outside the tool homes, stays
// unreadable.
it.runIf(process.platform === "darwin")(
  "a restricted macOS command reads the version manager files of the home, read only",
  async () => {
    const home = join(root, "home");
    const project = join(root, "project");
    const state = join(root, "state");
    await mkdir(join(home, ".asdf"), { recursive: true });
    await mkdir(project);
    await mkdir(state, { mode: 0o700 });
    await writeFile(join(home, ".asdf/x"), "shim");
    await writeFile(join(home, ".tool-versions"), "nodejs 22.12.0\n");
    await mkdir(join(home, ".ssh"));
    await writeFile(join(home, ".ssh/id_ed25519"), "private");
    await writeFile(join(home, "outside.txt"), "plain");
    const h = JSON.stringify(home);
    const worker = await startMacOperationWorker(
      {
        kind: "exec",
        scope: { operationId: "tool-homes", tag: "tool-homes" } as never,
        grant: {
          full: false,
          readRoots: [project],
          writeRoots: [project],
          hosts: [],
          deniedReadRoots: [state, join(home, ".ssh")],
          revision: "r",
        },
        args: {
          command: [
            `H=${h}`,
            'printf %s "$ASDF_DATA_DIR" > env',
            'cat "$ASDF_DATA_DIR/x" > got-x',
            'cat "$H/.tool-versions" > got-versions',
            '(printf y >> "$H/.asdf/x") 2>/dev/null && printf w > wrote-x',
            '(printf y > "$H/.asdf/new") 2>/dev/null && printf w > wrote-new',
            '(printf y >> "$H/.tool-versions") 2>/dev/null && printf w > wrote-versions',
            'cat "$H/.ssh/id_ed25519" > got-secret 2>/dev/null || rm -f got-secret',
            'cat "$H/outside.txt" > got-outside 2>/dev/null || rm -f got-outside',
            "true",
          ].join("; "),
          cwd: project,
          timeoutMs: 60_000,
          maxOutputBytes: 1 << 16,
        },
        stateDir: state,
        pythonPath: "/usr/bin/python3",
        runtimeHash: workspace.runtimeHash,
        // the device's environment leaves ASDF_DATA_DIR unset
        toolHome: { home, env: {} },
        beforeLaunch: async () => {},
        onLaunch: async () => {},
      },
      new AbortController().signal,
    );
    const result = (await worker.completion) as ExecResult;
    expect(result.exitCode, result.stderr).toBe(0);
    const got = (name: string) =>
      existsSync(join(project, name)) ? readFileSync(join(project, name), "utf8") : null;
    expect(got("env")).toBe(join(home, ".asdf"));
    expect(got("got-x"), result.stderr).toBe("shim");
    expect(got("got-versions"), result.stderr).toBe("nodejs 22.12.0\n");
    for (const name of ["wrote-x", "wrote-new", "wrote-versions", "got-secret", "got-outside"])
      expect(got(name), name).toBeNull();
    expect(readFileSync(join(home, ".asdf/x"), "utf8")).toBe("shim");
    expect(readFileSync(join(home, ".tool-versions"), "utf8")).toBe("nodejs 22.12.0\n");
    expect(existsSync(join(home, ".asdf/new"))).toBe(false);
  },
);

// A restricted macOS command's HOME is the device's sandbox home (`<dir>/home`), not its working
// directory: it is writable and readable there, kept across commands, the XDG directories are
// under it, asdf's global pin is found through it, and the real home stays unwritable.
it.runIf(process.platform === "darwin")(
  "a restricted macOS command writes its home state to the device's sandbox home",
  async () => {
    const home = join(root, "owner");
    const device = join(root, "device");
    const project = join(root, "repo");
    const state = join(root, "state2");
    await mkdir(home);
    await mkdir(device);
    await mkdir(project);
    await mkdir(state, { mode: 0o700 });
    await writeFile(join(home, ".tool-versions"), "nodejs 22.12.0\n");
    const sandboxHome = join(device, "home");
    const run = async (command: string) => {
      const worker = await startMacOperationWorker(
        {
          kind: "exec",
          scope: { operationId: "sandbox-home", tag: "sandbox-home" } as never,
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
          toolHome: { home, env: {} },
          sandboxHome,
          beforeLaunch: async () => {},
          onLaunch: async () => {},
        },
        new AbortController().signal,
      );
      return (await worker.completion) as ExecResult;
    };
    const H = JSON.stringify(home);
    const first = await run(
      [
        'printf "%s|%s|%s" "$HOME" "$XDG_CACHE_HOME" "$XDG_CONFIG_HOME"',
        'mkdir -p "$XDG_CACHE_HOME" && printf kept > "$XDG_CACHE_HOME/state"',
        'cat "$HOME/.tool-versions" > versions',
        `(printf y > ${H}/written) 2>/dev/null && printf w > wrote-real`,
        "true",
      ].join("; "),
    );
    expect(first.exitCode, first.stderr).toBe(0);
    expect(first.stdout).toBe(
      `${sandboxHome}|${join(sandboxHome, ".cache")}|${join(sandboxHome, ".config")}`,
    );
    expect(readFileSync(join(project, "versions"), "utf8")).toBe("nodejs 22.12.0\n");
    expect(existsSync(join(project, "wrote-real"))).toBe(false);
    expect(existsSync(join(home, "written"))).toBe(false);
    // nothing of the home lands in the working directory
    expect(existsSync(join(project, ".cache"))).toBe(false);
    // the home is kept for the next command
    const second = await run('cat "$XDG_CACHE_HOME/state"');
    expect(second.exitCode, second.stderr).toBe(0);
    expect(second.stdout).toBe("kept");
  },
);
