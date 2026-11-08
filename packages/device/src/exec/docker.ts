import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
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
const CONTAINER_USER = "1000:1000";

/** A file operation in the container that takes longer than this is killed. */
const FILE_OP_TIMEOUT_S = 30;

const ROOTS: SandboxRoots = DEFAULT_SANDBOX_ROOTS;

/** Container name of an environment. */
export function containerName(environmentId: string): string {
  return `capybara-device-${environmentId}`;
}

interface DockerRun {
  code: number | null;
  stdout: Buffer;
  stderr: Buffer;
}

/** Runs `docker <args>` to completion (not a command of the environment). */
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
 * The command wrapper: runs the command, then records its exit status in a file under /tmp. The
 * host reads that file, because `docker exec` itself ends only when every process holding its
 * output (a background child) has closed it.
 */
const EXEC_WRAPPER =
  's=0; /bin/bash -c "$1" || s=$?; echo $s > "$2.tmp" && mv "$2.tmp" "$2"; exit $s';

/** How often the host looks for a finished command's status file. */
const DONE_POLL_MS = 40;

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
  /** The environment directory (from login). */
  dir: string;
  environmentId: string;
  policy: Policy;
}

interface Running {
  tag: string;
  killed: boolean;
  child: ChildProcess;
}

interface Inspected {
  Config: { Image: string };
  State: { Running: boolean };
  Mounts: { Source: string; Destination: string; RW: boolean }[];
  HostConfig: { NanoCpus: number; Memory: number };
  NetworkSettings: { Networks: Record<string, unknown> };
}

/**
 * Runs every command with `docker exec` in one long-lived container of the published sandbox
 * image: the environment directory's workspace, skills (read only) and tmp are mounted at
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
  /** Marks every process of this environment's commands: `<dirKey>.<tag>`. */
  private readonly dirKey: string;
  private readonly running = new Set<Running>();
  private chain: Promise<unknown> = Promise.resolve();
  private ready = false;
  /** The container has the default bridge (commands may reach the network). */
  private netOpen = false;
  private inflight = 0;
  private waiters: (() => void)[] = [];

  constructor(private readonly opts: DockerExecutorOptions) {
    const dir = resolve(opts.dir);
    this.dir = existsSync(dir) ? realpathSync(dir) : dir;
    this.hostRoots = osRoots(this.dir);
    this.guard = new RootGuard(this.dir, this.hostRoots);
    this.hostFiles = new HostFiles(this.hostRoots);
    this.name = containerName(opts.environmentId);
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

  /** Whether an existing container is the one this environment needs (image, mounts, limits). */
  private matches(c: Inspected): boolean {
    if (c.Config.Image !== SANDBOX_IMAGE) return false;
    const mounts = c.Mounts.map((m) => `${m.Destination}|${m.Source}|${m.RW}`).sort();
    const want = this.wanted()
      .map((m) => `${m.dest}|${m.source}|${m.rw}`)
      .sort();
    if (mounts.length !== want.length || mounts.some((m, i) => m !== want[i])) return false;
    const nano = this.opts.policy.cpu !== null ? Math.round(this.opts.policy.cpu * 1e9) : 0;
    const mem = this.opts.policy.memoryMb !== null ? this.opts.policy.memoryMb * 1024 * 1024 : 0;
    return c.HostConfig.NanoCpus === nano && c.HostConfig.Memory === mem;
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
      throw new DeviceOpError("error", "the environment directory is gone");
    }
    for (const r of Object.values(this.hostRoots)) mkdirSync(r, { recursive: true });
    let c = await this.inspect();
    if (c !== null && !this.matches(c)) {
      await this.mustDocker(["rm", "-f", this.name], "removing the old container");
      c = null;
    }
    if (c === null) {
      const { policy } = this.opts;
      await this.mustDocker(
        [
          "run",
          "-d",
          "--name",
          this.name,
          "--init",
          "--user",
          CONTAINER_USER,
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges:true",
          "--workdir",
          ROOTS.workspace,
          "--label",
          `capybara.device.environment=${this.opts.environmentId}`,
          ...this.wanted().flatMap((m) => ["-v", `${m.source}:${m.dest}${m.rw ? "" : ":ro"}`]),
          ...(policy.cpu !== null ? ["--cpus", String(policy.cpu)] : []),
          ...(policy.memoryMb !== null ? ["--memory", `${policy.memoryMb}m`] : []),
          "--entrypoint",
          "sleep",
          SANDBOX_IMAGE,
          "infinity",
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

  /** Waits until the container exists with the wanted network state; counts the caller as running. */
  private async acquire(open: boolean, signal: AbortSignal): Promise<void> {
    for (;;) {
      signal.throwIfAborted();
      const got = await this.serial(async () => {
        await this.ensureContainer();
        if (this.netOpen !== open) {
          // Other commands run with the other network state: wait for them.
          if (this.inflight > 0) return false;
          await this.setNet(open);
        }
        this.inflight++;
        return true;
      });
      if (got) return;
      await new Promise<void>((res, rej) => {
        const onAbort = (): void => rej(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        this.waiters.push(() => {
          signal.removeEventListener("abort", onAbort);
          res();
        });
      });
    }
  }

  private release(): void {
    this.inflight--;
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
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
    const doneName = `.capybara-exec-${randomBytes(8).toString("hex")}`;
    const doneInContainer = `${ROOTS.tmp}/${doneName}`;
    const doneOnHost = join(this.hostRoots.tmp, doneName);
    return new Promise<ExecResult>((resolvePromise, reject) => {
      const child = spawn(
        "docker",
        [
          "exec",
          "--workdir",
          cwd,
          ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
          this.name,
          "/bin/bash",
          "-c",
          EXEC_WRAPPER,
          "capybara-exec",
          args.command,
          doneInContainer,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
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
      const readDone = (): number | undefined => {
        try {
          const n = Number.parseInt(readFileSync(doneOnHost, "utf8"), 10);
          return Number.isNaN(n) ? undefined : n;
        } catch {
          return undefined;
        }
      };
      const poll = setInterval(() => {
        if (exit !== undefined || settled) return;
        const code = readDone();
        if (code === undefined) return;
        exit = { code, sig: null };
        grace = setTimeout(finish, PIPE_GRACE_MS);
      }, DONE_POLL_MS);
      const cleanup = (): void => {
        clearTimeout(timer);
        clearInterval(poll);
        if (grace) clearTimeout(grace);
        rmSync(doneOnHost, { force: true });
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
      child.stderr?.on("data", (b: Buffer) => {
        cap.push("stderr", b);
        if (dockerErr.length < 64) dockerErr.push(b);
      });
      child.once("error", (e) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(e);
      });
      child.once("exit", (code, sig) => {
        if (exit !== undefined) return;
        exit = { code: readDone() ?? code, sig };
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
      throw policyError(`${path} is outside the environment's roots (${roots.join(", ")})`);
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
        throw policyError(`${path} resolves outside the environment's roots`);
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

  /** Kills every process carrying this environment's marker (also a previous run's). */
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
