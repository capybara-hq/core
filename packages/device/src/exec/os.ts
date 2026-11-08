import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants, existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { DeviceExecArgs, ExecResult, SandboxRoots } from "@capybara-hq/plugin-sdk";
import { effectiveEgress, srtConfig } from "../policy.js";
import type { Policy } from "../state.js";
import { FS_HELPER_SCRIPT } from "./fs-helper.js";
import { EXEC_MARKER, killMarked } from "./procs.js";
import { DeviceOpError, type Executor } from "./types.js";

/** The file that marks a directory as an environment directory this program has used. */
export const ROOT_MARKER = ".capybara-device";

/** How long a finished command's output pipes may stay open (held by a background child). */
const PIPE_GRACE_MS = 200;

/** A file operation in the sandboxed helper that takes longer than this is killed. */
const HELPER_TIMEOUT_MS = 30_000;

/** How often process groups of finished commands are checked for remaining members. */
const PRUNE_INTERVAL_MS = 5_000;

/**
 * The outer process (the sandbox wrapper itself) runs with this environment only; the request's
 * environment is applied inside the sandbox, so it can never steer the wrapper.
 */
const OUTER_ENV: Record<string, string> = {
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  LANG: "C.UTF-8",
};

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

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

/**
 * One command's process group. It is tracked after the command's main process exits, as long as
 * the group has members (background children), so killTagged / killAll still reach them.
 */
interface Group {
  tag: string;
  pgid: number;
  /** The leader (the outer shell) has exited and been reaped. */
  exited: boolean;
  /** Called by a kill while the command runs: the result then has `exitCode: null`. */
  onKill?: (() => void) | undefined;
}

/** Sends SIGKILL to a process group; false when the group no longer exists. */
function killGroupId(pgid: number, signal: NodeJS.Signals | 0 = "SIGKILL"): boolean {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    return false;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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

interface Spawned {
  child: ChildProcess;
  commandId: string;
}

/**
 * Runs every command inside `@anthropic-ai/sandbox-runtime` (macOS Seatbelt, Linux bubblewrap):
 * writes only under the workspace and tmp roots, the secret paths unreadable, network only to
 * the intersection of the local policy and the environment's egress. File operations in the
 * workspace and tmp roots run in a sandboxed helper too. Construct it with
 * {@link createOsExecutor}; the constructor alone serves only `ensureRoot` and the skills root.
 */
export class OsExecutor implements Executor {
  readonly mode = "os" as const;
  readonly roots: SandboxRoots;
  private readonly dir: string;
  /** Marks every process of this environment's commands: `<dirKey>.<tag>`. */
  private readonly dirKey: string;
  private readonly groups = new Set<Group>();
  private pruneTimer: NodeJS.Timeout | undefined;
  /** The marker was seen in this process: its vanishing means the directory was removed. */
  private seen = false;

  constructor(private readonly opts: OsExecutorOptions) {
    const dir = resolve(opts.dir);
    // The roots are reported as real paths, so what commands print matches what the kernel sends.
    this.dir = existsSync(dir) ? realpathSync(dir) : dir;
    this.roots = osRoots(this.dir);
    this.dirKey = createHash("sha256").update(this.dir).digest("hex").slice(0, 16);
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

  /** The marker value of a tag's processes. */
  markerOf(tag: string): string {
    return `${this.dirKey}.${tag}`;
  }

  /**
   * Wraps `script` (run by bash inside the sandbox, after the request's `env` and TMPDIR are
   * exported) and spawns it as the leader of a new process group.
   */
  private async spawnSandboxed(
    script: string,
    o: {
      cwd: string;
      env?: Record<string, string>;
      tag: string;
      egress: string[];
      signal?: AbortSignal;
      stdin?: boolean;
    },
  ): Promise<Spawned> {
    const exports: string[] = [];
    const inner: Record<string, string> = {
      // The user's PATH applies inside the sandbox only (the wrapper runs with OUTER_ENV).
      PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
      LANG: process.env.LANG ?? "C.UTF-8",
      SHELL: "/bin/bash",
      TERM: "dumb",
      HOME: this.roots.workspace,
      ...(process.env.USER !== undefined && { USER: process.env.USER }),
      ...o.env,
      // The runtime points TMPDIR at its own /tmp/claude (denied by the config): use the tmp root.
      TMPDIR: this.roots.tmp,
      [EXEC_MARKER]: this.markerOf(o.tag),
    };
    for (const [k, v] of Object.entries(inner)) {
      if (!ENV_NAME_RE.test(k))
        throw policyError(`invalid environment variable name ${JSON.stringify(k)}`);
      exports.push(`export ${k}=${shellQuote(v)}`);
    }
    const commandId = randomBytes(16).toString("base64url");
    const wrapped = await SandboxManager.wrapWithSandbox(
      `${exports.join("\n")}\n${script}`,
      "/bin/bash",
      undefined,
      o.signal,
      { commandId, commandText: script },
    );
    // The kernel may have cancelled while the wrap was prepared.
    o.signal?.throwIfAborted();
    if (o.egress.length > 0) {
      SandboxManager.registerCommandNetworkLists(commandId, { allowedDomains: o.egress });
    }
    let child: ChildProcess;
    try {
      // detached: the command leads its own process group, so a kill reaches its children too.
      child = spawn("/bin/bash", ["-c", wrapped], {
        cwd: o.cwd,
        env: OUTER_ENV,
        detached: true,
        stdio: [o.stdin ? "pipe" : "ignore", "pipe", "pipe"],
      });
    } catch (e) {
      SandboxManager.unregisterCommandNetworkLists(commandId);
      SandboxManager.cleanupAfterCommand();
      throw e;
    }
    return { child, commandId };
  }

  /** Tracks a spawned command's process group; returns the entry. */
  private track(tag: string, child: ChildProcess): Group | undefined {
    if (child.pid === undefined) return undefined;
    const g: Group = { tag, pgid: child.pid, exited: false };
    this.groups.add(g);
    if (this.pruneTimer === undefined) {
      this.pruneTimer = setInterval(() => this.prune(), PRUNE_INTERVAL_MS);
      this.pruneTimer.unref();
    }
    return g;
  }

  /** Forgets finished groups with no members left (or whose id was taken by another process). */
  private prune(): void {
    for (const g of this.groups) {
      if (!g.exited) continue;
      // A reaped leader's pid can be reused only once its group is gone: a live process with
      // that pid means the id now belongs to someone else.
      if (pidAlive(g.pgid) || !killGroupId(g.pgid, 0)) this.groups.delete(g);
    }
    if (this.groups.size === 0 && this.pruneTimer !== undefined) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = undefined;
    }
  }

  private killGroup(g: Group): void {
    if (g.exited) {
      this.prune();
      if (!this.groups.has(g)) return;
    }
    g.onKill?.();
    if (!killGroupId(g.pgid) && g.exited) this.groups.delete(g);
  }

  async exec(args: DeviceExecArgs, signal: AbortSignal): Promise<ExecResult> {
    signal.throwIfAborted();
    const cwd = await this.inside(args.cwd ?? this.roots.workspace, "cwd");
    const { child, commandId } = await this.spawnSandboxed(args.command, {
      cwd,
      ...(args.env !== undefined && { env: args.env }),
      tag: args.tag,
      egress: effectiveEgress(this.opts.policy, args.limits),
      signal,
    });
    return new Promise<ExecResult>((resolvePromise, reject) => {
      const cap = new OutputCap(args.maxOutputBytes);
      let timedOut = false;
      let killed = false;
      let exit: { code: number | null; sig: NodeJS.Signals | null } | undefined;
      let settled = false;
      let grace: NodeJS.Timeout | undefined;
      const group = this.track(args.tag, child);
      if (group) {
        group.onKill = () => {
          // A kill after a clean exit (a background child) leaves the result alone.
          if (exit === undefined) killed = true;
        };
      }
      const kill = (): void => {
        if (group) this.killGroup(group);
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
        if (group) this.groups.delete(group);
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

  /** Runs one file operation in the sandboxed helper; returns its `r`, throws its `e`. */
  private async helper(
    op: "read" | "stat" | "write",
    path: string,
    maxBytes: number,
    data?: Uint8Array,
  ): Promise<unknown> {
    const script = [
      process.execPath,
      "-e",
      FS_HELPER_SCRIPT,
      op,
      path,
      String(maxBytes),
      this.roots.workspace,
      this.roots.tmp,
    ]
      .map(shellQuote)
      .join(" ");
    const { child, commandId } = await this.spawnSandboxed(script, {
      cwd: this.roots.workspace,
      tag: "fs-helper",
      egress: [],
      stdin: data !== undefined,
    });
    const chunks: Buffer[] = [];
    const errs: Buffer[] = [];
    child.stdout?.on("data", (b: Buffer) => chunks.push(b));
    child.stderr?.on("data", (b: Buffer) => errs.push(b));
    if (child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(data !== undefined ? Buffer.from(data) : undefined);
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) killGroupId(child.pid);
    }, HELPER_TIMEOUT_MS);
    try {
      await new Promise<void>((res, rej) => {
        child.once("error", rej);
        child.once("close", () => res());
      });
    } finally {
      clearTimeout(timer);
      if (child.pid !== undefined) killGroupId(child.pid);
      SandboxManager.unregisterCommandNetworkLists(commandId);
      SandboxManager.cleanupAfterCommand();
    }
    if (timedOut) throw new DeviceOpError("error", `${op} ${path} timed out`);
    const text = Buffer.concat(chunks).toString("utf8");
    let res: { r?: unknown; e?: "policy" | "error"; m?: string };
    try {
      res = JSON.parse(text) as typeof res;
    } catch {
      const stderr = Buffer.concat(errs).toString("utf8").trim().slice(0, 500);
      throw new DeviceOpError(
        "error",
        `${op} ${path} failed in the sandbox${stderr ? `: ${stderr}` : ""}`,
      );
    }
    if (res.e !== undefined)
      throw new DeviceOpError(res.e === "policy" ? "policy" : "error", res.m ?? "failed");
    return res.r ?? null;
  }

  async readFile(
    path: string,
    maxBytes: number,
  ): Promise<{ data: Uint8Array; truncated: boolean } | null> {
    const p = this.lexical(path);
    if (this.inSkills(p)) return this.readSkills(path, maxBytes);
    const r = (await this.helper("read", p, maxBytes)) as {
      b64: string;
      truncated: boolean;
    } | null;
    return r === null ? null : { data: Buffer.from(r.b64, "base64"), truncated: r.truncated };
  }

  async writeFile(path: string, data: Uint8Array): Promise<void> {
    const p = this.lexical(path);
    if (this.inSkills(p)) return this.writeSkills(path, data);
    await this.helper("write", p, 0, data);
  }

  async stat(path: string): Promise<{ size: number; isDir: boolean } | null> {
    const p = this.lexical(path);
    if (this.inSkills(p)) {
      const real = await this.existing(path);
      if (real === null) return null;
      const st = await lstat(real);
      return { size: st.size, isDir: st.isDirectory() };
    }
    return (await this.helper("stat", p, 0)) as { size: number; isDir: boolean } | null;
  }

  async killTagged(tags: string[]): Promise<void> {
    const want = new Set(tags);
    for (const g of [...this.groups]) if (want.has(g.tag)) this.killGroup(g);
    const values = new Set(tags.map((t) => this.markerOf(t)));
    await killMarked((v) => values.has(v));
  }

  async killAll(): Promise<void> {
    for (const g of [...this.groups]) this.killGroup(g);
    await this.killLeftovers();
  }

  /** Kills every process carrying this environment's marker (also a previous run's). */
  async killLeftovers(): Promise<void> {
    const prefix = `${this.dirKey}.`;
    await killMarked((v) => v.startsWith(prefix));
  }

  /** Kills every running command and shuts the sandbox's proxies down. */
  async dispose(): Promise<void> {
    await this.killAll();
    if (this.pruneTimer !== undefined) clearInterval(this.pruneTimer);
    this.pruneTimer = undefined;
    await SandboxManager.reset();
  }

  private inSkills(p: string): boolean {
    return isUnder(p, this.roots.skills);
  }

  /**
   * Skills are read only to commands (and `<dir>` is not writable to them), so nothing can race
   * these in-process operations; they still resolve links and stay inside the roots.
   */
  private async readSkills(
    path: string,
    maxBytes: number,
  ): Promise<{ data: Uint8Array; truncated: boolean } | null> {
    const real = await this.existing(path);
    if (real === null) return null;
    const fh = await open(real, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    try {
      const st = await fh.stat();
      if (st.isDirectory()) return null;
      if (!st.isFile()) throw policyError(`${path} is not a regular file`);
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

  private async writeSkills(path: string, data: Uint8Array): Promise<void> {
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
      constants.O_WRONLY | constants.O_CREAT | constants.O_NONBLOCK | constants.O_NOFOLLOW,
      0o644,
    );
    try {
      if (!(await fh.stat()).isFile()) throw policyError(`${path} is not a regular file`);
      await fh.truncate(0);
      await fh.writeFile(data);
    } finally {
      await fh.close();
    }
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
 * The OS sandbox executor: checks the platform and dependencies, starts the sandbox's proxies
 * once for this process, and kills what a previous run of this environment left running.
 * Network is denied unless a command's own list allows it.
 */
export async function createOsExecutor(opts: OsExecutorOptions): Promise<OsExecutor> {
  const available = sandboxAvailability();
  if (!available.ok) throw new Error(available.reason);
  const executor = new OsExecutor(opts);
  // No ask callback: a destination outside the lists is refused, never prompted.
  await SandboxManager.initialize(executor.config());
  await executor.killLeftovers();
  return executor;
}
