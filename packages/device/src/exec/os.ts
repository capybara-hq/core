import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants, existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { DeviceExecArgs, ExecResult, SandboxRoots } from "@capybara-hq/plugin-sdk";
import { effectiveEgress, srtConfig } from "../policy.js";
import type { Policy } from "../state.js";
import { DeviceOpError, type Executor } from "./types.js";

/** The file that marks a directory as an environment directory this program has used. */
export const ROOT_MARKER = ".capybara-device";

/** How long a finished command's output pipes may stay open (held by a background child). */
const PIPE_GRACE_MS = 200;

/** The roots of an environment directory: `<dir>/workspace`, `<dir>/skills`, `<dir>/tmp`. */
export function osRoots(dir: string): SandboxRoots {
  return { workspace: join(dir, "workspace"), skills: join(dir, "skills"), tmp: join(dir, "tmp") };
}

/** Whether the OS sandbox can run here, and why not. */
export function sandboxAvailability(): { ok: true } | { ok: false; reason: string } {
  if (!SandboxManager.isSupportedPlatform()) {
    return { ok: false, reason: `the OS sandbox does not support ${process.platform}` };
  }
  const deps = SandboxManager.checkDependencies();
  if (deps.errors.length > 0) {
    return {
      ok: false,
      reason: `the OS sandbox is missing dependencies: ${deps.errors.join("; ")}`,
    };
  }
  return { ok: true };
}

/**
 * The longest prefix of `b` that does not end inside a UTF-8 sequence (a cut buffer's tail is
 * dropped instead of decoding to U+FFFD).
 */
export function utf8Prefix(b: Buffer): Buffer {
  let i = b.length - 1;
  let cont = 0;
  while (i >= 0 && cont < 3 && ((b[i] as number) & 0xc0) === 0x80) {
    i--;
    cont++;
  }
  if (i < 0) return b;
  const lead = b[i] as number;
  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return b.length - i >= need ? b : b.subarray(0, i);
}

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}

function isUnder(p: string, root: string): boolean {
  return p === root || p.startsWith(`${root}/`);
}

function policyError(message: string): DeviceOpError {
  return new DeviceOpError("policy", message);
}

function isMissing(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** Captures stdout and stderr up to a combined byte budget; the rest is drained and dropped. */
class OutputCap {
  private readonly chunks = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
  private readonly cut = { stdout: false, stderr: false };
  private used = 0;
  truncated = false;

  constructor(private readonly max: number) {}

  push(stream: "stdout" | "stderr", buf: Buffer): void {
    const room = this.max - this.used;
    if (buf.length <= room) {
      this.chunks[stream].push(buf);
      this.used += buf.length;
      return;
    }
    if (room > 0) this.chunks[stream].push(buf.subarray(0, room));
    this.used = this.max;
    this.truncated = true;
    this.cut[stream] = true;
  }

  text(stream: "stdout" | "stderr"): string {
    const all = Buffer.concat(this.chunks[stream]);
    return (this.cut[stream] ? utf8Prefix(all) : all).toString("utf8");
  }
}

interface Running {
  tag: string;
  kill: () => void;
}

export interface OsExecutorOptions {
  /** The environment directory (from login). */
  dir: string;
  policy: Policy;
  /** The home whose secret paths are denied (default: the user's home). */
  home?: string;
  /** More paths commands may not read (this program's state directory). */
  denyRead?: string[];
}

/**
 * Runs every command inside `@anthropic-ai/sandbox-runtime` (macOS Seatbelt, Linux bubblewrap):
 * writes only under the workspace and tmp roots, the secret paths unreadable, network only to
 * the intersection of the local policy and the environment's egress. Construct it with
 * {@link createOsExecutor}; the constructor alone serves the file operations only.
 */
export class OsExecutor implements Executor {
  readonly mode = "os" as const;
  readonly roots: SandboxRoots;
  private readonly dir: string;
  private readonly running = new Set<Running>();
  /** The marker was seen in this process: its vanishing means the directory was removed. */
  private seen = false;

  constructor(private readonly opts: OsExecutorOptions) {
    const dir = resolve(opts.dir);
    // The roots are reported as real paths, so what commands print matches what the kernel sends.
    this.dir = existsSync(dir) ? realpathSync(dir) : dir;
    this.roots = osRoots(this.dir);
  }

  /** The configuration the sandbox is initialized with (no domains: those are per command). */
  config(): SandboxRuntimeConfig {
    return srtConfig(this.opts.policy, this.roots, [], {
      ...(this.opts.home !== undefined && { home: this.opts.home }),
      ...(this.opts.denyRead !== undefined && { denyRead: this.opts.denyRead }),
    });
  }

  async ensureRoot(): Promise<"ok" | "gone"> {
    const marker = join(this.dir, ROOT_MARKER);
    if (existsSync(marker)) {
      this.seen = true;
    } else {
      // login creates the directory, so a missing one was removed after login.
      if (this.seen || !existsSync(this.dir)) return "gone";
      writeFileSync(marker, "This directory is a capybara-device environment.\n");
      this.seen = true;
    }
    for (const r of [this.roots.workspace, this.roots.skills, this.roots.tmp]) {
      mkdirSync(r, { recursive: true });
    }
    return "ok";
  }

  async exec(args: DeviceExecArgs, signal: AbortSignal): Promise<ExecResult> {
    signal.throwIfAborted();
    const cwd = await this.inside(args.cwd ?? this.roots.workspace, "cwd");
    const commandId = randomBytes(16).toString("base64url");
    // The runtime points TMPDIR at its own /tmp/claude (denied by the config); use the tmp root.
    const inner = `export TMPDIR=${shellQuote(this.roots.tmp)}\n${args.command}`;
    const wrapped = await SandboxManager.wrapWithSandbox(inner, "/bin/bash", undefined, signal, {
      commandId,
      commandText: args.command,
    });
    // The kernel may have cancelled while the wrap was prepared.
    signal.throwIfAborted();
    const egress = effectiveEgress(this.opts.policy, args.limits);
    if (egress.length > 0)
      SandboxManager.registerCommandNetworkLists(commandId, { allowedDomains: egress });
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      LANG: process.env.LANG ?? "C.UTF-8",
      SHELL: "/bin/bash",
      TERM: "dumb",
      ...(process.env.USER !== undefined && { USER: process.env.USER }),
      HOME: this.roots.workspace,
      TMPDIR: this.roots.tmp,
      ...args.env,
    };
    let child: ChildProcess;
    try {
      // detached: the command leads its own process group, so a kill reaches its children too.
      child = spawn("/bin/bash", ["-c", wrapped], {
        cwd,
        env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      SandboxManager.unregisterCommandNetworkLists(commandId);
      throw e;
    }
    return new Promise<ExecResult>((resolvePromise, reject) => {
      const cap = new OutputCap(args.maxOutputBytes);
      let timedOut = false;
      let killed = false;
      let exit: { code: number | null; sig: NodeJS.Signals | null } | undefined;
      let settled = false;
      let grace: NodeJS.Timeout | undefined;
      const killGroup = (): void => {
        killed = true;
        if (child.pid === undefined) return;
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      };
      const entry: Running = { tag: args.tag, kill: killGroup };
      this.running.add(entry);
      const timer = setTimeout(() => {
        timedOut = true;
        killGroup();
      }, args.timeoutMs);
      const onAbort = (): void => killGroup();
      signal.addEventListener("abort", onAbort, { once: true });
      const cleanup = (): void => {
        clearTimeout(timer);
        if (grace) clearTimeout(grace);
        signal.removeEventListener("abort", onAbort);
        this.running.delete(entry);
        SandboxManager.unregisterCommandNetworkLists(commandId);
        SandboxManager.cleanupAfterCommand();
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
        cleanup();
        reject(e);
      });
      child.once("exit", (code, sig) => {
        exit = { code, sig };
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
    const real = await this.existing(path);
    if (real === null) return null;
    const fh = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const st = await fh.stat();
      if (st.isDirectory()) return null;
      const want = Math.min(st.size, maxBytes);
      const buf = Buffer.alloc(want);
      let off = 0;
      while (off < want) {
        const { bytesRead } = await fh.read(buf, off, want - off, off);
        if (bytesRead === 0) break;
        off += bytesRead;
      }
      return { data: buf.subarray(0, off), truncated: st.size > maxBytes };
    } finally {
      await fh.close();
    }
  }

  async writeFile(path: string, data: Uint8Array): Promise<void> {
    const target = this.lexical(path);
    const parent = dirname(target);
    // Check the nearest existing ancestor before creating anything beneath it.
    let ancestor = parent;
    while (!existsSync(ancestor)) ancestor = dirname(ancestor);
    await this.inside(ancestor, "path");
    await mkdir(parent, { recursive: true });
    const realParent = await this.inside(parent, "path");
    let file = join(realParent, basename(target));
    const st = await lstat(file).catch((e: unknown) => {
      if (isMissing(e)) return null;
      throw e;
    });
    if (st?.isSymbolicLink()) {
      const real = await realpath(file).catch((e: unknown) => {
        if (isMissing(e)) throw policyError(`${path} is a dangling symbolic link`);
        throw e;
      });
      file = await this.inside(real, "path");
    }
    const fh = await open(
      file,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
      0o644,
    );
    try {
      await fh.writeFile(data);
    } finally {
      await fh.close();
    }
  }

  async stat(path: string): Promise<{ size: number; isDir: boolean } | null> {
    const real = await this.existing(path);
    if (real === null) return null;
    const st = await lstat(real);
    return { size: st.size, isDir: st.isDirectory() };
  }

  async killTagged(tags: string[]): Promise<void> {
    const want = new Set(tags);
    for (const r of this.running) if (want.has(r.tag)) r.kill();
  }

  async killAll(): Promise<void> {
    for (const r of this.running) r.kill();
  }

  /** Kills every running command and shuts the sandbox's proxies down. */
  async dispose(): Promise<void> {
    await this.killAll();
    await SandboxManager.reset();
  }

  /** `path` made absolute and normalized; refused unless it is lexically under a root. */
  private lexical(path: string): string {
    if (!isAbsolute(path)) throw policyError(`${path} is not an absolute path`);
    const p = resolve(path);
    if (!this.rootList().some((r) => isUnder(p, r))) {
      throw policyError(
        `${path} is outside the environment's roots (${this.rootList().join(", ")})`,
      );
    }
    return p;
  }

  /** The real path of an existing `path`, refused unless under a root after resolving links; null when missing. */
  private async existing(path: string): Promise<string | null> {
    const p = this.lexical(path);
    let real: string;
    try {
      real = await realpath(p);
    } catch (e) {
      if (isMissing(e)) return null;
      throw e;
    }
    return this.checkReal(path, real);
  }

  /** The real path of an existing `path` under a root (symlinks resolved); refused otherwise. */
  private async inside(path: string, what: string): Promise<string> {
    const p = this.lexical(path);
    let real: string;
    try {
      real = await realpath(p);
    } catch (e) {
      if (isMissing(e)) throw new DeviceOpError("error", `${what} ${path} does not exist`);
      throw e;
    }
    return this.checkReal(path, real);
  }

  private async checkReal(path: string, real: string): Promise<string> {
    const roots = await Promise.all(this.rootList().map((r) => realpath(r).catch(() => r)));
    if (!roots.some((r) => isUnder(real, r))) {
      throw policyError(`${path} resolves to ${real}, outside the environment's roots`);
    }
    return real;
  }

  private rootList(): string[] {
    return [this.roots.workspace, this.roots.skills, this.roots.tmp];
  }
}

/**
 * The OS sandbox executor: checks the platform and dependencies, then starts the sandbox's
 * proxies once for this process. Network is denied unless a command's own list allows it.
 */
export async function createOsExecutor(opts: OsExecutorOptions): Promise<OsExecutor> {
  const available = sandboxAvailability();
  if (!available.ok) throw new Error(available.reason);
  const executor = new OsExecutor(opts);
  // No ask callback: a destination outside the lists is refused, never prompted.
  await SandboxManager.initialize(executor.config());
  return executor;
}
