import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { resolve } from "node:path";
import type { DeviceExecArgs, ExecResult, SandboxRoots } from "@capybara-hq/plugin-sdk";
import { dirKeyOf, GroupTracker } from "./groups.js";
import { EXEC_MARKER, killMarked } from "./procs.js";
import {
  ENV_NAME_RE,
  HostFiles,
  OutputCap,
  osRoots,
  PIPE_GRACE_MS,
  policyError,
  RootGuard,
} from "./shared.js";
import type { ExecHooks, Executor } from "./types.js";

export interface HostExecutorOptions {
  /** The device directory (from login). */
  dir: string;
  /** The environment commands start from (default: this program's own, `process.env`). */
  env?: NodeJS.ProcessEnv;
}

/**
 * Runs commands without a sandbox (spec §4.1): `/bin/bash -c` directly on this machine as the
 * user, with this program's own environment plus the request's, so commands see the real `HOME`,
 * `PATH`, credentials, Docker and network. That is auto mode; the program picks this executor per
 * command (see `exec/switch.ts`) when no sandbox is in force.
 *
 * What stays the same as the OS sandbox: the working directory defaults to the device's workspace,
 * every command leads its own process group and carries {@link EXEC_MARKER}, so timeouts, aborts,
 * `killTagged` and `killAll` reach it and what it leaves running. File operations reach any
 * absolute path on the machine (the kernel's `Read` / `Write` / `Edit` / `Glob` / `Grep` do, and
 * the deployment reviews writes outside the workspace, spec §5.1).
 */
export class HostExecutor implements Executor {
  readonly mode = "os" as const;
  readonly roots: SandboxRoots;
  private readonly dir: string;
  /** Marks every process of this device's commands: `<dirKey>.<tag>` (as the OS executor). */
  private readonly dirKey: string;
  private readonly groups = new GroupTracker();
  private readonly guard: RootGuard;
  private readonly files: HostFiles;

  constructor(private readonly opts: HostExecutorOptions) {
    const dir = resolve(opts.dir);
    this.dir = existsSync(dir) ? realpathSync(dir) : dir;
    this.roots = osRoots(this.dir);
    this.guard = new RootGuard(this.dir, this.roots);
    this.files = new HostFiles(this.roots, "auto");
    this.dirKey = dirKeyOf(this.dir);
  }

  async ensureRoot(): Promise<"ok" | "gone"> {
    return this.guard.ensure();
  }

  /** The marker value of a tag's processes. */
  markerOf(tag: string): string {
    return `${this.dirKey}.${tag}`;
  }

  /** The command's environment: this program's, the request's, then the marker. */
  private envFor(args: DeviceExecArgs): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.opts.env ?? process.env)) {
      if (v !== undefined) env[k] = v;
    }
    for (const [k, v] of Object.entries(args.env ?? {})) {
      if (!ENV_NAME_RE.test(k))
        throw policyError(`invalid environment variable name ${JSON.stringify(k)}`);
      env[k] = v;
    }
    env[EXEC_MARKER] = this.markerOf(args.tag);
    return env;
  }

  async exec(args: DeviceExecArgs, signal: AbortSignal, hooks?: ExecHooks): Promise<ExecResult> {
    signal.throwIfAborted();
    const cwd = await this.files.inside(args.cwd ?? this.roots.workspace, "cwd");
    const env = this.envFor(args);
    // The kernel may have cancelled while the cwd was checked.
    signal.throwIfAborted();
    // The sandbox may have been turned back on meanwhile: judged again with no await before the
    // spawn, so a kill of every unsandboxed command never misses this one.
    hooks?.beforeSpawn?.();
    // detached: the command leads its own process group, so a kill reaches its children too.
    const child: ChildProcess = spawn("/bin/bash", ["-c", args.command], {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return new Promise<ExecResult>((resolvePromise, reject) => {
      const cap = new OutputCap(args.maxOutputBytes);
      let timedOut = false;
      let killed = false;
      let exit: { code: number | null; sig: NodeJS.Signals | null } | undefined;
      let settled = false;
      let grace: NodeJS.Timeout | undefined;
      const group = this.groups.track(args.tag, child);
      if (group) {
        group.onKill = () => {
          // A kill after a clean exit (a background child) leaves the result alone.
          if (exit === undefined) killed = true;
        };
      }
      const kill = (): void => {
        if (group) this.groups.kill(group);
      };
      const timer = setTimeout(() => {
        if (exit === undefined) timedOut = true;
        kill();
      }, args.timeoutMs);
      const onAbort = (): void => kill();
      signal.addEventListener("abort", onAbort, { once: true });
      const cleanup = (): void => {
        clearTimeout(timer);
        if (grace) clearTimeout(grace);
        signal.removeEventListener("abort", onAbort);
        if (group) {
          group.exited = true;
          group.onKill = undefined;
        }
      };
      const finish = (): void => {
        if (settled || exit === undefined) return;
        settled = true;
        cleanup();
        child.stdout?.destroy();
        child.stderr?.destroy();
        let exitCode: number | null = exit.code;
        if (killed || timedOut) exitCode = null;
        else if (exitCode === null && exit.sig !== null) {
          exitCode = 128 + (osConstants.signals[exit.sig] ?? 0);
        }
        resolvePromise({
          exitCode,
          stdout: cap.text("stdout"),
          stderr: cap.text("stderr"),
          truncated: cap.truncated,
          timedOut,
        });
      };
      child.stdout?.on("data", (b: Buffer) => cap.push("stdout", b));
      child.stderr?.on("data", (b: Buffer) => cap.push("stderr", b));
      child.once("error", (e) => {
        if (settled) return;
        settled = true;
        if (group) this.groups.forget(group);
        cleanup();
        reject(e);
      });
      child.once("exit", (code, sig) => {
        exit = { code, sig };
        if (group) group.exited = true;
        // A background child may hold the pipes open; do not wait for it past a short grace.
        grace = setTimeout(finish, PIPE_GRACE_MS);
      });
      child.once("close", () => finish());
    });
  }

  async readFile(
    path: string,
    maxBytes: number,
  ): Promise<{ data: Uint8Array; truncated: boolean } | null> {
    return this.files.read(path, maxBytes);
  }

  async writeFile(path: string, data: Uint8Array): Promise<void> {
    await this.files.write(path, data);
  }

  async stat(path: string): Promise<{ size: number; isDir: boolean } | null> {
    return this.files.stat(path);
  }

  async killTagged(tags: string[]): Promise<void> {
    this.groups.killTags(tags);
    const values = new Set(tags.map((t) => this.markerOf(t)));
    await killMarked((v) => values.has(v));
  }

  async killAll(): Promise<void> {
    this.groups.killAll();
    await this.killLeftovers();
  }

  /** Kills every process carrying this device's marker (also a previous run's). */
  async killLeftovers(): Promise<void> {
    const prefix = `${this.dirKey}.`;
    await killMarked((v) => v.startsWith(prefix));
  }

  /** Kills every running command and stops tracking. */
  async dispose(): Promise<void> {
    await this.killAll();
    this.groups.dispose();
  }
}
