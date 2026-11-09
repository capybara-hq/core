import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  DEFAULT_SANDBOX_ROOTS,
  type DeviceExecArgs,
  type ExecResult,
  type SandboxRoots,
} from "@capybara-hq/plugin-sdk";
import { effectiveEgress } from "../policy.js";
import type { Policy } from "../state.js";
import { EXEC_MARKER } from "./procs.js";
import {
  ENV_NAME_RE,
  HostFiles,
  isUnder,
  OutputCap,
  osRoots,
  PIPE_GRACE_MS,
  policyError,
  RootGuard,
} from "./shared.js";
import { DeviceOpError, type Executor } from "./types.js";

/** The version of the published sandbox images this program runs commands in. */
export const SANDBOX_IMAGE_TAG = "0.1.0-rc.5";

export const SANDBOX_IMAGE = `ghcr.io/capybara-hq/capybara-sandbox:${SANDBOX_IMAGE_TAG}`;

/** The image's `sandbox` user. */
const IMAGE_USER = "1000:1000";

/**
 * The user commands run as. On Linux the bind-mounted device directory belongs to the host user,
 * so the container runs as that uid:gid (never root: a root host user falls back to the image's user).
 * Docker Desktop (macOS) maps file ownership itself, so the image's user is used there.
 */
export function containerUser(
  platform: NodeJS.Platform = process.platform,
  uid: number | undefined = process.getuid?.(),
  gid: number | undefined = process.getgid?.(),
): string {
  if (platform !== "linux" || uid === undefined || gid === undefined || uid === 0)
    return IMAGE_USER;
  return `${uid}:${gid}`;
}

const SPEC_LABEL = "capybara.device.spec";

/** A file operation in the container that takes longer than this is killed. */
const FILE_OP_TIMEOUT_S = 30;

const ROOTS: SandboxRoots = DEFAULT_SANDBOX_ROOTS;

/** Container name of a device. */
export function containerName(deviceId: string): string {
  return `capybara-device-${deviceId}`;
}

interface DockerRun {
  code: number | null;
  stdout: Buffer;
  stderr: Buffer;
}

/** Runs `docker <args>` to completion (not a command of the device). */
function docker(
  args: string[],
  o: { input?: Uint8Array; timeoutMs?: number; maxBytes?: number } = {},
): Promise<DockerRun> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("docker", args, { stdio: [o.input ? "pipe" : "ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    const max = o.maxBytes ?? 64 * 1024 * 1024;
    child.stdout?.on("data", (b: Buffer) => {
      if (size < max) out.push(b);
      size += b.length;
    });
    child.stderr?.on("data", (b: Buffer) => err.push(b));
    if (child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(Buffer.from(o.input as Uint8Array));
    }
    const timer =
      o.timeoutMs !== undefined ? setTimeout(() => child.kill("SIGKILL"), o.timeoutMs) : undefined;
    child.once("error", (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.once("close", (code) => {
      if (timer) clearTimeout(timer);
      resolvePromise({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err) });
    });
  });
}

/** Whether the docker CLI can reach a daemon, and why not. */
export async function dockerAvailability(): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const r = await docker(["info", "--format", "{{.ServerVersion}}"], { timeoutMs: 10_000 });
    if (r.code === 0) return { ok: true };
    const why = r.stderr.toString("utf8").trim().split("\n")[0] ?? "";
    return { ok: false, reason: `Docker is not available${why ? `: ${why}` : ""}` };
  } catch {
    return { ok: false, reason: "the docker command was not found" };
  }
}

/** Kills the processes whose `CAPYBARA_EXEC` is `$1` exactly, or starts with `$2` (when `$1` is empty). */
const KILL_SCRIPT = `m=$1; pre=$2; for round in 1 2; do for e in /proc/[0-9]*/environ; do
p=\${e%/environ}; p=\${p#/proc/}; [ "$p" = "$$" ] && continue
if [ -n "$m" ]; then tr '\\0' '\\n' < "$e" 2>/dev/null | grep -qxF "${EXEC_MARKER}=$m" && kill -9 "$p" 2>/dev/null
else tr '\\0' '\\n' < "$e" 2>/dev/null | grep -q "^${EXEC_MARKER}=$pre" && kill -9 "$p" 2>/dev/null; fi
done; done; exit 0`;

/**
 * The command wrapper. The host sends a random nonce on stdin; the wrapper keeps it in a shell
 * variable, runs the command (stdin `/dev/null`), then writes one final line on stderr with the
 * nonce and the exit status. `docker exec` itself ends only when every process holding its
 * output (a background child) has closed it, so the host reads the status from this line instead.
 * The command cannot suppress the line (the wrapper writes it after waiting) and never sees the
 * nonce; a forged line without it is ordinary output.
 */
const EXEC_WRAPPER =
  'read -r n; /bin/bash -c "$1" </dev/null; s=$?; printf \'\\nCAPYBARA-DONE:%s:%d:END\\n\' "$n" "$s" >&2; exit $s';

/** The pids limit of a container (as the cloud sandbox). */
const PIDS_LIMIT = 1024;

/** The shared prologue of the file scripts: `under` checks a real path against the three roots. */
const FILE_PROLOGUE = `under() { case "$1" in /workspace|/workspace/*|/tmp|/tmp/*) return 0;; esac; return 1; }
`;

// Exit codes of the file scripts.
const E_MISSING = 10;
const E_OUTSIDE = 11;
const E_NOT_FILE = 12;
const E_FAIL = 13;
const E_DANGLING = 14;

const READ_SCRIPT = `${FILE_PROLOGUE}r=$(realpath -e -- "$1" 2>/dev/null) || exit ${E_MISSING}
under "$r" || exit ${E_OUTSIDE}
[ -d "$r" ] && exit ${E_MISSING}
[ -f "$r" ] || exit ${E_NOT_FILE}
head -c "$2" -- "$r"`;

const STAT_SCRIPT = `${FILE_PROLOGUE}r=$(realpath -e -- "$1" 2>/dev/null) || exit ${E_MISSING}
under "$r" || exit ${E_OUTSIDE}
if [ -d "$r" ]; then printf '%s d' "$(stat -c %s -- "$r")"; else printf '%s f' "$(stat -c %s -- "$r")"; fi`;

const WRITE_SCRIPT = `${FILE_PROLOGUE}p=$1; d=$(dirname -- "$p"); a=$d
while [ ! -e "$a" ] && [ "$a" != / ]; do a=$(dirname -- "$a"); done
ra=$(realpath -e -- "$a" 2>/dev/null) || exit ${E_FAIL}
under "$ra" || exit ${E_OUTSIDE}
mkdir -p -- "$d" || exit ${E_FAIL}
rp=$(realpath -e -- "$d" 2>/dev/null) || exit ${E_FAIL}
under "$rp" || exit ${E_OUTSIDE}
f="$rp/$(basename -- "$p")"
if [ -L "$f" ]; then r=$(realpath -e -- "$f" 2>/dev/null) || exit ${E_DANGLING}; under "$r" || exit ${E_OUTSIDE}; f=$r; fi
if [ -e "$f" ] && [ ! -f "$f" ]; then exit ${E_NOT_FILE}; fi
cat > "$f" || exit ${E_FAIL}`;

export interface DockerExecutorOptions {
  /** The device directory (from login). */
  dir: string;
  deviceId: string;
  policy: Policy;
}

interface Waiter {
  open: boolean;
  dead: boolean;
  /** The caller was counted in `inflight`. */
  counted: boolean;
  resolve: () => void;
  reject: (e: unknown) => void;
}

interface Running {
  tag: string;
  killed: boolean;
  child: ChildProcess;
}

interface Inspected {
  Config: { Image: string; Labels: Record<string, string> | null };
  State: { Running: boolean };
  Mounts: { Source: string; Destination: string; RW: boolean }[];
  HostConfig: { NanoCpus: number; Memory: number };
  NetworkSettings: { Networks: Record<string, unknown> };
}

/**
 * Runs every command with `docker exec` in one long-lived container of the published sandbox
 * image: the device directory's workspace, skills (read only) and tmp are mounted at
 * /workspace, /skills and /tmp. Workspace and tmp files are read and written inside the container
 * (as the `sandbox` user, so a link a command plants resolves in the container and never on the
 * host); the skills directory, which commands cannot write, is accessed from the host with the
 * same real-path checks as the OS executor. Network: none unless the effective egress is
 * non-empty, then the default bridge (Docker mode has no domain allowlist).
 */
export class DockerExecutor implements Executor {
  readonly mode = "docker" as const;
  readonly roots: SandboxRoots = ROOTS;
  readonly name: string;
  private readonly dir: string;
  private readonly hostRoots: SandboxRoots;
  private readonly guard: RootGuard;
  private readonly hostFiles: HostFiles;
  /** Marks every process of this device's commands: `<dirKey>.<tag>`. */
  private readonly dirKey: string;
  private readonly running = new Set<Running>();
  private chain: Promise<unknown> = Promise.resolve();
  private ready = false;
  /** The container has the default bridge (commands may reach the network). */
  private netOpen = false;
  private inflight = 0;
  private readonly queue: Waiter[] = [];
  private pumping = false;
  private dirty = false;

  constructor(private readonly opts: DockerExecutorOptions) {
    const dir = resolve(opts.dir);
    this.dir = existsSync(dir) ? realpathSync(dir) : dir;
    this.hostRoots = osRoots(this.dir);
    this.guard = new RootGuard(this.dir, this.hostRoots);
    this.hostFiles = new HostFiles(this.hostRoots);
    this.name = containerName(opts.deviceId);
    this.dirKey = createHash("sha256").update(this.dir).digest("hex").slice(0, 16);
  }

  async ensureRoot(): Promise<"ok" | "gone"> {
    return this.guard.ensure();
  }

  markerOf(tag: string): string {
    return `${this.dirKey}.${tag}`;
  }

  private serial<T>(f: () => Promise<T>): Promise<T> {
    const next = this.chain.then(f, f);
    this.chain = next.catch(() => {});
    return next;
  }

  private async inspect(): Promise<Inspected | null> {
    const r = await docker(["inspect", "--type", "container", this.name]);
    if (r.code !== 0) return null;
    return (JSON.parse(r.stdout.toString("utf8")) as Inspected[])[0] ?? null;
  }

  private wanted(): { source: string; dest: string; rw: boolean }[] {
    return [
      { source: this.hostRoots.workspace, dest: ROOTS.workspace, rw: true },
      { source: this.hostRoots.skills, dest: ROOTS.skills, rw: false },
      { source: this.hostRoots.tmp, dest: ROOTS.tmp, rw: true },
    ];
  }

  /** Every `docker run` flag of the container except its name and spec label. */
  private runArgs(): string[] {
    const { policy } = this.opts;
    return [
      "--init",
      "--read-only",
      "--user",
      containerUser(),
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
      "--pids-limit",
      String(PIDS_LIMIT),
      "--workdir",
      ROOTS.workspace,
      "--label",
      `capybara.device.id=${this.opts.deviceId}`,
      ...this.wanted().flatMap((m) => [
        "--mount",
        `type=bind,source=${m.source},target=${m.dest}${m.rw ? "" : ",readonly"}`,
      ]),
      ...(policy.cpu !== null ? ["--cpus", String(policy.cpu)] : []),
      ...(policy.memoryMb !== null
        ? ["--memory", `${policy.memoryMb}m`, "--memory-swap", `${policy.memoryMb}m`]
        : []),
      "--entrypoint",
      "sleep",
      SANDBOX_IMAGE,
      "infinity",
    ];
  }

  /** A hash of the run flags: a container made with other flags is recreated. */
  private specHash(): string {
    return createHash("sha256").update(JSON.stringify(this.runArgs())).digest("hex").slice(0, 16);
  }

  private matches(c: Inspected): boolean {
    return c.Config.Labels?.[SPEC_LABEL] === this.specHash();
  }

  private async mustDocker(args: string[], what: string): Promise<DockerRun> {
    const r = await docker(args);
    if (r.code !== 0) {
      throw new DeviceOpError(
        "error",
        `${what} failed: ${r.stderr.toString("utf8").trim().slice(0, 500)}`,
      );
    }
    return r;
  }

  /** Creates the container, or reuses the existing one when it matches; call inside `serial`. */
  private async ensureContainer(): Promise<void> {
    if (this.ready) return;
    if (!existsSync(this.dir)) {
      throw new DeviceOpError("error", "the device directory is gone");
    }
    for (const r of Object.values(this.hostRoots)) {
      if (r.includes(",")) {
        throw new DeviceOpError("error", `the device directory ${this.dir} contains a comma`);
      }
      mkdirSync(r, { recursive: true });
    }
    let c = await this.inspect();
    if (c !== null && (!this.matches(c) || !(await this.seesHostRoots(c)))) {
      await this.mustDocker(["rm", "-f", this.name], "removing the old container");
      c = null;
    }
    if (c === null) {
      await this.mustDocker(
        [
          "run",
          "-d",
          "--name",
          this.name,
          "--label",
          `${SPEC_LABEL}=${this.specHash()}`,
          ...this.runArgs(),
        ],
        "creating the container",
      );
      // Created on the default bridge (a container created with `none` cannot join it later).
      this.netOpen = true;
    } else {
      if (!c.State.Running) await this.mustDocker(["start", this.name], "starting the container");
      this.netOpen = "bridge" in (await this.inspectNetworks());
    }
    this.ready = true;
  }

  /**
   * Whether a reused container's mounts still show this directory's roots: after the directory was
   * removed and recreated (`login` again), a Linux bind mount still holds the deleted one.
   */
  private async seesHostRoots(c: Inspected): Promise<boolean> {
    if (!c.State.Running) await this.mustDocker(["start", this.name], "starting the container");
    const probe = `.capybara-mount-probe-${randomBytes(8).toString("hex")}`;
    const checks = this.wanted();
    try {
      for (const m of checks) writeFileSync(join(m.source, probe), "");
      const script = checks.map((m) => `[ -e ${m.dest}/${probe} ]`).join(" && ");
      const r = await docker(["exec", this.name, "/bin/sh", "-c", script], { timeoutMs: 10_000 });
      return r.code === 0;
    } finally {
      for (const m of checks) rmSync(join(m.source, probe), { force: true });
    }
  }

  private async inspectNetworks(): Promise<Record<string, unknown>> {
    const c = await this.inspect();
    return c?.NetworkSettings.Networks ?? {};
  }

  private async setNet(open: boolean): Promise<void> {
    await this.mustDocker(
      ["network", open ? "connect" : "disconnect", "bridge", this.name],
      open ? "enabling the network" : "disabling the network",
    );
    this.netOpen = open;
  }

  /**
   * Waits until the container exists with the wanted network state and counts the caller as
   * running. Callers are served in arrival order: once one needs the other network state, later
   * callers for the current state queue behind it, so it is not starved.
   */
  private acquire(open: boolean, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    return new Promise<void>((resolveWait, rejectWait) => {
      const w: Waiter = {
        open,
        dead: false,
        counted: false,
        resolve: resolveWait,
        reject: rejectWait,
      };
      const onAbort = (): void => {
        w.dead = true;
        this.dequeue(w);
        rejectWait(signal.reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      const done = w.resolve;
      w.resolve = () => {
        signal.removeEventListener("abort", onAbort);
        done();
      };
      this.queue.push(w);
      this.pump();
    });
  }

  private pump(): void {
    if (this.pumping) {
      this.dirty = true;
      return;
    }
    this.pumping = true;
    void this.drain().finally(() => {
      this.pumping = false;
      if (this.dirty) this.pump();
    });
  }

  private dequeue(w: Waiter): void {
    const i = this.queue.indexOf(w);
    if (i >= 0) this.queue.splice(i, 1);
  }

  private async drain(): Promise<void> {
    do {
      this.dirty = false;
      while (this.queue.length > 0) {
        const w = this.queue[0] as Waiter;
        if (w.dead) {
          this.dequeue(w);
          continue;
        }
        let served: boolean;
        try {
          served = await this.serial(async () => {
            await this.ensureContainer();
            if (w.dead) return true;
            if (this.netOpen !== w.open) {
              // Commands run with the other network state: wait for them.
              if (this.inflight > 0) return false;
              await this.setNet(w.open);
            }
            this.inflight++;
            w.counted = true;
            return true;
          });
        } catch (e) {
          // An abort while being served already removed it; never remove another waiter.
          this.dequeue(w);
          if (!w.dead) w.reject(e);
          continue;
        }
        if (!served) break;
        this.dequeue(w);
        if (w.dead) {
          // Aborted while being served: give back the slot if it was counted.
          if (w.counted) this.inflight--;
          continue;
        }
        w.resolve();
      }
    } while (this.dirty);
  }

  private release(): void {
    this.inflight--;
    this.pump();
  }

  /** A docker-level failure that means the container vanished: the next call recreates it. */
  private noteFailure(stderr: string): void {
    if (/No such container|is not running|is restarting/i.test(stderr)) this.ready = false;
  }

  async exec(args: DeviceExecArgs, signal: AbortSignal): Promise<ExecResult> {
    signal.throwIfAborted();
    const cwd = this.containerPath(args.cwd ?? ROOTS.workspace);
    const env: Record<string, string> = {
      HOME: ROOTS.workspace,
      TERM: "dumb",
      ...args.env,
      TMPDIR: ROOTS.tmp,
      [EXEC_MARKER]: this.markerOf(args.tag),
    };
    for (const k of Object.keys(env)) {
      if (!ENV_NAME_RE.test(k))
        throw policyError(`invalid environment variable name ${JSON.stringify(k)}`);
    }
    const open = effectiveEgress(this.opts.policy, args.limits).length > 0;
    await this.acquire(open, signal);
    try {
      signal.throwIfAborted();
      return await this.run(args, cwd, env, signal);
    } finally {
      this.release();
    }
  }

  private run(
    args: DeviceExecArgs,
    cwd: string,
    env: Record<string, string>,
    signal: AbortSignal,
  ): Promise<ExecResult> {
    const nonce = randomBytes(16).toString("hex");
    return new Promise<ExecResult>((resolvePromise, reject) => {
      const child = spawn(
        "docker",
        [
          "exec",
          "-i",
          "--workdir",
          cwd,
          ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
          this.name,
          "/bin/bash",
          "-c",
          EXEC_WRAPPER,
          "capybara-exec",
          args.command,
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      child.stdin?.on("error", () => {});
      child.stdin?.end(`${nonce}\n`);
      const sentinel = Buffer.from(`\nCAPYBARA-DONE:${nonce}:`);
      const entry: Running = { tag: args.tag, killed: false, child };
      this.running.add(entry);
      const cap = new OutputCap(args.maxOutputBytes);
      const dockerErr: Buffer[] = [];
      let timedOut = false;
      let exit: { code: number | null; sig: NodeJS.Signals | null } | undefined;
      let settled = false;
      let grace: NodeJS.Timeout | undefined;
      const kill = (): void => {
        if (exit === undefined) entry.killed = true;
        void this.killMarker(this.markerOf(args.tag)).then(() => {
          // The docker client normally ends with the command; never leave it behind.
          setTimeout(() => child.kill("SIGKILL"), 1000).unref();
        });
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
        // A background child may keep the client attached: it is not needed any more.
        child.kill("SIGKILL");
        signal.removeEventListener("abort", onAbort);
        this.running.delete(entry);
      };
      const finish = (): void => {
        if (settled || exit === undefined) return;
        settled = true;
        cleanup();
        child.stdout?.destroy();
        child.stderr?.destroy();
        if (status === undefined && pending.length > 0) cap.push("stderr", pending);
        const stderr = cap.text("stderr");
        if (exit.code === 126 || exit.code === 125 || exit.code === 1) {
          this.noteFailure(Buffer.concat(dockerErr).toString("utf8"));
        }
        resolvePromise({
          exitCode: entry.killed || timedOut ? null : (exit.code ?? 128),
          stdout: cap.text("stdout"),
          stderr,
          truncated: cap.truncated,
          timedOut,
        });
      };
      child.stdout?.on("data", (b: Buffer) => cap.push("stdout", b));
      // stderr carries the wrapper's final status line; hold back a tail that might begin it.
      let pending = Buffer.alloc(0);
      let status: Buffer | undefined;
      const onStderr = (b: Buffer): void => {
        if (dockerErr.length < 64) dockerErr.push(b);
        if (status !== undefined) {
          status = Buffer.concat([status, b]);
        } else {
          const data = Buffer.concat([pending, b]);
          const at = data.indexOf(sentinel);
          if (at >= 0) {
            cap.push("stderr", data.subarray(0, at));
            pending = Buffer.alloc(0);
            status = data.subarray(at + sentinel.length);
          } else {
            const keep = Math.min(data.length, sentinel.length - 1);
            cap.push("stderr", data.subarray(0, data.length - keep));
            pending = data.subarray(data.length - keep);
          }
        }
        if (status !== undefined && exit === undefined) {
          const m = /^(\d+):END\n/.exec(status.toString("latin1"));
          if (m) {
            exit = { code: Number(m[1]), sig: null };
            grace = setTimeout(finish, PIPE_GRACE_MS);
          }
        }
      };
      child.stderr?.on("data", onStderr);
      child.once("error", (e) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(e);
      });
      child.once("exit", (code, sig) => {
        if (exit !== undefined) return;
        exit = { code, sig };
        grace = setTimeout(finish, PIPE_GRACE_MS);
      });
      child.once("close", () => finish());
    });
  }

  /** `path` made absolute and normalized; refused unless lexically under a root. */
  private containerPath(path: string): string {
    if (!path.startsWith("/")) throw policyError(`${path} is not an absolute path`);
    const p = resolve(path);
    const roots = Object.values(ROOTS);
    if (!roots.some((r) => isUnder(p, r))) {
      throw policyError(`${path} is outside the device's roots (${roots.join(", ")})`);
    }
    return p;
  }

  /** The host path of a /skills path (the skills directory is mounted read only). */
  private skillsHostPath(p: string): string {
    return join(this.hostRoots.skills, p.slice(ROOTS.skills.length));
  }

  private inSkills(p: string): boolean {
    return isUnder(p, ROOTS.skills);
  }

  /** Runs one file script in the container; `null` for a missing file. */
  private async fileOp(
    script: string,
    path: string,
    arg2: string,
    input?: Uint8Array,
  ): Promise<DockerRun | null> {
    // A file operation does not need the network; it runs on whichever state the container has.
    await this.serial(() => this.ensureContainer());
    const r = await docker(
      [
        "exec",
        ...(input !== undefined ? ["-i"] : []),
        this.name,
        "timeout",
        "-s",
        "KILL",
        String(FILE_OP_TIMEOUT_S),
        "/bin/sh",
        "-c",
        script,
        "capybara-file",
        path,
        arg2,
      ],
      {
        ...(input !== undefined && { input }),
        timeoutMs: (FILE_OP_TIMEOUT_S + 5) * 1000,
      },
    );
    return this.fileResult(r, path);
  }

  private fileResult(r: DockerRun, path: string): DockerRun | null {
    switch (r.code) {
      case 0:
        return r;
      case E_MISSING:
        return null;
      case E_OUTSIDE:
        throw policyError(`${path} resolves outside the device's roots`);
      case E_NOT_FILE:
        throw policyError(`${path} is not a regular file`);
      case E_DANGLING:
        throw policyError(`${path} is a dangling symbolic link`);
      default:
        this.noteFailure(r.stderr.toString("utf8"));
        throw new DeviceOpError(
          "error",
          `file operation on ${path} failed: ${r.stderr.toString("utf8").trim().slice(0, 300)}`,
        );
    }
  }

  async readFile(
    path: string,
    maxBytes: number,
  ): Promise<{ data: Uint8Array; truncated: boolean } | null> {
    const p = this.containerPath(path);
    if (this.inSkills(p)) return this.hostFiles.read(this.skillsHostPath(p), maxBytes);
    const r = await this.fileOp(READ_SCRIPT, p, String(maxBytes + 1));
    if (r === null) return null;
    return {
      data: r.stdout.subarray(0, maxBytes),
      truncated: r.stdout.length > maxBytes,
    };
  }

  async writeFile(path: string, data: Uint8Array): Promise<void> {
    const p = this.containerPath(path);
    if (this.inSkills(p)) return this.hostFiles.write(this.skillsHostPath(p), data);
    await this.fileOp(WRITE_SCRIPT, p, "", data);
  }

  async stat(path: string): Promise<{ size: number; isDir: boolean } | null> {
    const p = this.containerPath(path);
    if (this.inSkills(p)) return this.hostFiles.stat(this.skillsHostPath(p));
    const r = await this.fileOp(STAT_SCRIPT, p, "");
    if (r === null) return null;
    const [size, kind] = r.stdout.toString("utf8").split(" ");
    return { size: Number(size), isDir: kind === "d" };
  }

  /** Kills the container processes of one marker (exact) or marker prefix. */
  private async killScript(marker: string, prefix: string): Promise<void> {
    try {
      await docker(
        ["exec", this.name, "/bin/sh", "-c", KILL_SCRIPT, "capybara-kill", marker, prefix],
        { timeoutMs: 15_000 },
      );
    } catch {
      // No docker, or no container: nothing of ours runs.
    }
  }

  private killMarker(marker: string): Promise<void> {
    return this.killScript(marker, "");
  }

  async killTagged(tags: string[]): Promise<void> {
    const want = new Set(tags);
    for (const r of this.running) if (want.has(r.tag)) r.killed = true;
    await Promise.all(tags.map((t) => this.killMarker(this.markerOf(t))));
  }

  async killAll(): Promise<void> {
    for (const r of this.running) r.killed = true;
    await this.killLeftovers();
  }

  /** Kills every process carrying this device's marker (also a previous run's). */
  async killLeftovers(): Promise<void> {
    await this.killScript("", `${this.dirKey}.`);
  }

  /** Kills every running command; the container stays for the next start. */
  async dispose(): Promise<void> {
    await this.killAll();
  }
}

/** The Docker executor: checks the daemon and kills what a previous run left running. */
export async function createDockerExecutor(opts: DockerExecutorOptions): Promise<DockerExecutor> {
  const available = await dockerAvailability();
  if (!available.ok) throw new Error(available.reason);
  const executor = new DockerExecutor(opts);
  await executor.killLeftovers();
  return executor;
}
