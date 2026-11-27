import { createHash } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  unlink,
} from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { dirname, isAbsolute, join, normalize } from "node:path";
import {
  DEVICE_SERVICE_ID_RE,
  DEVICE_SERVICE_INSTALL_ENV,
  DEVICE_SERVICE_INSTALL_KEY_FILE,
  DEVICE_SERVICE_INSTALL_SEAL,
  DEVICE_SERVICE_SOCKET_ENV,
  DEVICE_SERVICE_STATE_ENV,
  DEVICE_SERVICE_WORKSPACE_ENV,
  type DeviceServiceStatus,
  deviceServiceFilesDigest,
  encodeServiceMessage,
  type SandboxLimits,
  SandboxPermissionUnsupportedError,
  SandboxScopeDeniedError,
  ServiceMessageDecoder,
} from "@capybara-hq/plugin-sdk";
import { type InstallCache, type InstallLease, validInstallKey } from "./install-cache.js";

/**
 * The longest unix socket path a service is given, in bytes: macOS's `sun_path` holds 104 bytes
 * including the terminating NUL (Linux's 108), so 103 fits both.
 */
export const MAX_SERVICE_SOCKET_PATH_BYTES = 103;

/** The socket's file name inside the state directory: one byte, to leave room for the path. */
const SOCKET_NAME = "s";
/** The service's temporary directory inside the state directory. */
const TMP_NAME = "tmp";
/** The file in the code directory holding the digest the spec files were written under. */
const DIGEST_NAME = ".files-digest";
/** A provider's opaque digest of a service's files (`service.ensure` `filesDigest`). */
export const FILES_DIGEST_RE = /^[A-Za-z0-9:_-]{1,128}$/;

/** How long a started service has to create its socket before the start fails. */
export const SERVICE_READY_TIMEOUT_MS = 15_000;

/** How long a stopped service gets to exit on its own before it is killed. */
export const SERVICE_STOP_GRACE_MS = 2_000;

/**
 * How long a service that removed its socket (it is stopping on its own: an idle stop, a crash
 * handler) gets to exit before this program stops it, so a request can start a fresh one.
 */
export const SERVICE_EXITING_GRACE_MS = 2_000;

/** The record in `svc/` that the bare-name entries from before ids were removed (once). */
const LEGACY_PRUNED_MARKER = ".ids-v1";

/** The device's service state root: `<device dir>/svc`, outside every workspace and project. */
export const serviceRoot = (deviceDir: string) => join(deviceDir, "svc");

/**
 * The device's service code root: `<device dir>/svc-files`, one directory per service holding
 * exactly the spec's files and their digest (controller ruling R30). Only this program writes
 * there; a service reads its code from it and can never change it, so a start on stored files
 * runs the files the deployment sent, whatever the service did to its own state directory.
 */
export const serviceCodeRoot = (deviceDir: string) => join(deviceDir, "svc-files");

/**
 * The device's service install root: `<device dir>/svc-install`, one directory per service
 * ({@link DEVICE_SERVICE_INSTALL_ENV}: writable by the service until it seals it, read only from
 * its next start on) and, beside each, the record `.<id>` of the files digest the directory was
 * filled under (a dot name no service id can take). Only this program writes the records.
 */
export const serviceInstallRoot = (deviceDir: string) => join(deviceDir, "svc-install");

/**
 * The paths of one service (browser use spec §5): its state directory `<device dir>/svc/<name>`
 * (its files and its only write root besides the workspace downloads) and the socket the service
 * listens on, a file `s` inside the state directory.
 *
 * Short socket path strategy: a unix socket path must fit {@link MAX_SERVICE_SOCKET_PATH_BYTES},
 * and the device directory is the owner's choice (its default `~/capybara-device/<device id>`
 * leaves room for a 32-character name, a deep one does not). When `<state dir>/s` is too long, the
 * service is given `<alias root>/<16 hex>/s` instead, where `<16 hex>` is a symbolic link to the
 * state directory (a hash of its path) made by this program in its private alias root
 * (`/tmp/capybara-svc-<uid>` by default, 0700): the socket file still lives in the state
 * directory, only the name it is bound and reached by is short.
 */
export function servicePaths(
  deviceDir: string,
  name: string,
  aliasRoot: string,
): { stateDir: string; socket: string; alias?: string } {
  const stateDir = join(serviceRoot(deviceDir), name);
  const direct = join(stateDir, SOCKET_NAME);
  if (Buffer.byteLength(direct) <= MAX_SERVICE_SOCKET_PATH_BYTES)
    return { stateDir, socket: direct };
  const alias = join(aliasRoot, createHash("sha256").update(stateDir).digest("hex").slice(0, 16));
  const socket = join(alias, SOCKET_NAME);
  if (Buffer.byteLength(socket) > MAX_SERVICE_SOCKET_PATH_BYTES)
    throw new Error(
      `The service socket alias root ${aliasRoot} is too long for a unix socket path; use a shorter one`,
    );
  return { stateDir, socket, alias };
}

/** The default private alias root of {@link servicePaths}. */
export function defaultSocketAliasRoot(): string {
  return `/tmp/capybara-svc-${process.getuid?.() ?? "user"}`;
}

/** A service to start, decoded from the wire (`service.ensure`). */
export interface LocalServiceSpec {
  name: string;
  /** The script to run: a relative path inside `files`. */
  entry: string;
  args: string[];
  /**
   * Written into the service's code directory (`<device dir>/svc-files/<name>`, read only for the
   * service) before start, keyed by relative path. Absent: the files already there are used when
   * they were written under the ensure's `filesDigest`.
   */
  files?: Record<string, Uint8Array>;
  env?: Record<string, string>;
}

/** What a launcher starts: one service process under the device's local sandbox. */
export interface ServiceLaunch {
  name: string;
  /** `process.execPath`, the script, then the spec's arguments. */
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  stateDir: string;
  /**
   * The state directory and `<workspace>/downloads`, and the install directory while it is not
   * sealed ({@link DEVICE_SERVICE_INSTALL_ENV}).
   */
  writeRoots: string[];
  /** What the service reads besides its write roots. */
  readRoots: string[];
  /** Where the service may bind its unix socket (the state directory, and its alias if any). */
  unixSockets: string[];
  /** A temporary directory inside the state directory (TMPDIR). */
  tmpDir: string;
  /**
   * The device's network as the deployment holds it (the provider's limits), intersected by the
   * launcher with the owner's ceiling; absent, the service gets no network (fail closed).
   */
  network?: SandboxLimits["network"];
}

/** A running service process. */
export interface ServiceProcess {
  /**
   * The owner ceiling revision the launch's grant was built under, when the launcher reads one
   * ({@link ServiceLauncher.ceilingRevision}): a later revision stops the service at the next
   * {@link ServiceSupervisor.reconcile}.
   */
  readonly ceilingRevision?: string;
  /** Resolves when the process is gone (exit code, or null when killed). */
  readonly exited: Promise<{ code: number | null }>;
  /** Ends the process: a polite signal, then a kill after `graceMs`. Resolves once it is gone. */
  stop(graceMs: number): Promise<void>;
  /** The last of its output, for an error message when it fails to start. */
  output(): string;
}

/** Starts service processes under the local sandbox (one per platform and device mode). */
export interface ServiceLauncher {
  launch(req: ServiceLaunch, signal: AbortSignal): Promise<ServiceProcess>;
  /**
   * The network a launch with `network` would get now, as a comparable key (after the owner's
   * ceiling): a running service whose key differs is restarted. Absent: {@link networkKey}.
   */
  networkKey?(network: SandboxLimits["network"] | undefined): Promise<string>;
  /** The owner ceiling revision a launch would be built under now (absent: never changes). */
  ceilingRevision?(): Promise<string>;
  /**
   * What this launcher tells a service that may change what it installs (the macOS launcher's
   * Mach allowances decide which Chromium build the browser installs): part of the install
   * cache's scope, so a launch told something else never reuses an install made for another.
   */
  installVariant?(): string;
}

/** A service's request or stream connection could not be served. */
export class ServiceNotRunningError extends Error {
  constructor(name: string) {
    super(`The device service ${name} is not running; start it with ensureService first`);
    this.name = "ServiceNotRunningError";
  }
}

/** A start needs the spec's files: none were sent and the state directory's do not match. */
export class ServiceFilesNeededError extends Error {
  constructor(name: string, why: string) {
    super(
      `The device service ${name} needs its files to start (${why}); send them with the ensure`,
    );
    this.name = "ServiceFilesNeededError";
  }
}

/** A malformed service request (a typed `invalid` answer, never a protocol error). */
export class ServiceSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServiceSpecError";
  }
}

interface Running {
  proc: ServiceProcess;
  /** The effective network it was started with ({@link ServiceLauncher.networkKey}). */
  network: string;
  /** The device's network as the launch was asked for (before the owner's ceiling). */
  launchNetwork: SandboxLimits["network"] | undefined;
  /** The spec it was launched with, its files left out: a restart runs exactly this again. */
  spec: Omit<LocalServiceSpec, "files">;
  /**
   * The digest of the code it runs: the ensure's `filesDigest`, else the digest of the files it
   * was sent; undefined when neither was known. An ensure naming other files restarts it.
   */
  filesDigest: string | undefined;
  startedAt: string;
  socket: string;
  /** The connections this program opened to the service; ended when it exits. */
  conns: Set<Socket>;
  /** Resolves when the process is gone and the record is cleared. */
  gone: Promise<void>;
  /** Set when this program stops it (a stop, a restart, a reconcile): it is not started again. */
  stopping: boolean;
}

export interface ServiceSupervisorOptions {
  /** The device directory (`<dir>/svc/<name>` holds each service's state). */
  deviceDir: string;
  /** The device's workspace root: `<workspace>/downloads` is the service's other write root. */
  workspace: string;
  /** The launcher of this host, read at each start; undefined where services are unsupported. */
  launcher: () => ServiceLauncher | undefined;
  /** The private alias root of the short socket path strategy ({@link servicePaths}). */
  socketAliasRoot?: string;
  readyTimeoutMs?: number;
  /** A test seam: runs right before the launch, after every directory was made and checked. */
  beforeLaunch?: () => Promise<void>;
  /** How long a service without its socket gets to exit ({@link SERVICE_EXITING_GRACE_MS}). */
  exitingGraceMs?: number;
  /**
   * The machine-wide install cache (capybara-hq/plugins#311): a service whose files carry
   * {@link DEVICE_SERVICE_INSTALL_KEY_FILE} gets its install directory from it instead of
   * `<device dir>/svc-install/<id>`. Absent: every install is the device's own.
   */
  installCache?: InstallCache;
  now?: () => Date;
}

/** The network a service runs with, comparable: kind and sorted hosts, or none. */
export function networkKey(n: SandboxLimits["network"] | undefined): string {
  if (!n) return "none";
  return `${n.kind}:${[...new Set(n.hosts.map((h) => h.toLowerCase()))].sort().join(",")}`;
}

/** Rejects with `signal`'s reason when it aborts first; `p` itself goes on. */
function withSignal<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

const refusePath = (path: string, what: string) =>
  new SandboxScopeDeniedError(
    `${path} is ${what}, not a plain directory or file of the device; remove it and retry`,
  );

/**
 * Makes (or checks) the real directory `base/<parts...>` one component at a time, never following
 * a link: a symbolic link or any other non-directory on the way is refused. The service's state
 * directory is its own write root and persists, so a service may have planted a link there; this
 * program writes outside the sandbox and must never follow one. `base` is the device's own.
 */
export async function realDirectory(base: string, parts: readonly string[]): Promise<string> {
  let dir = base;
  for (const part of parts) {
    dir = join(dir, part);
    for (;;) {
      try {
        const st = await lstat(dir);
        if (st.isSymbolicLink()) throw refusePath(dir, "a symbolic link");
        if (!st.isDirectory()) throw refusePath(dir, "not a directory");
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        try {
          await mkdir(dir, { mode: 0o700 });
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        }
      }
    }
  }
  return dir;
}

/**
 * Removes what is at `path` unless it is a directory (refused): a link is removed itself, never
 * its target; a hard link loses only this name.
 */
async function removeEntry(path: string): Promise<void> {
  try {
    const st = await lstat(path);
    if (st.isDirectory()) throw refusePath(path, "a directory");
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/**
 * Writes a spec file inside a {@link realDirectory}: the old entry (whatever it is: a link, a hard
 * link to a file elsewhere) is removed, then a new file is created exclusively without following
 * links, so the write never lands outside the state directory.
 */
async function writeNewFile(path: string, content: Uint8Array): Promise<void> {
  await removeEntry(path);
  const fh = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await fh.writeFile(content);
  } finally {
    await fh.close();
  }
}

/**
 * The resolved `path`, refused unless it lies strictly inside the resolved `parent` (a link swapped
 * in after the checks would point elsewhere).
 */
async function resolvedInside(path: string, parent: string): Promise<string> {
  const [real, base] = await Promise.all([realpath(path), realpath(parent)]);
  if (!real.startsWith(`${base}/`))
    throw new SandboxScopeDeniedError(
      `${path} resolves outside ${parent}; remove the link and retry`,
    );
  return real;
}

/** A relative path of a spec file: no `..`, not absolute, no empty or `.` segment. */
export function checkRelativePath(p: string, what: string): string {
  if (
    typeof p !== "string" ||
    p.length === 0 ||
    p.length > 512 ||
    isAbsolute(p) ||
    p.includes("\0") ||
    p.includes("\\") ||
    p.split("/").some((s) => s === "" || s === "." || s === "..") ||
    normalize(p) !== p
  )
    throw new ServiceSpecError(`${what} must be a relative path inside the service's files: ${p}`);
  return p;
}

/**
 * The named services of one device (browser use spec §5): each runs under the device's local
 * sandbox through the host's {@link ServiceLauncher}, with `process.execPath` as its Node runtime,
 * writing only in its state directory, `<workspace>/downloads` and its install directory until it
 * seals it ({@link DEVICE_SERVICE_INSTALL_ENV}). `ensure` starts a service that
 * is not running (its files are written then, and only then) and is a no-op for a running one
 * with the same network (a changed network restarts it, {@link ServiceSupervisor.ensure}); a
 * service that exits stays stopped until the next `ensure` (never restarted automatically). This
 * program is one process per device, so the table lives in its memory: a service is a child of
 * the launcher's worker and ends with this program. The kernel stops services by stopping the
 * instance: a machine that was offline when the device was suspended keeps its services running
 * until a lifecycle call reaches it after it reconnects (the next idle suspension or machine stop,
 * or the next instance create: each stops them all) or this program ends.
 */
export class ServiceSupervisor {
  private readonly running = new Map<string, Running>();
  /** The ensure or restart in flight per name (they run one after another per name). */
  private readonly starting = new Map<string, Promise<unknown>>();
  /** Aborts the start in flight per name (a stop during a start). */
  private readonly startCtl = new Map<string, AbortController>();
  private readonly aliasRoot: string;
  private readonly now: () => Date;

  constructor(private readonly o: ServiceSupervisorOptions) {
    this.aliasRoot = o.socketAliasRoot ?? defaultSocketAliasRoot();
    this.now = o.now ?? (() => new Date());
  }

  /**
   * The service's status with its state directory (`<device dir>/svc/<name>`) and code directory
   * (`<device dir>/svc-files/<name>`), known before its first start and the same for every start
   * of the name on this device.
   */
  status(name: string): DeviceServiceStatus {
    if (!DEVICE_SERVICE_ID_RE.test(name))
      throw new ServiceSpecError(`Invalid device service id: ${name}`);
    const stateDir = join(serviceRoot(this.o.deviceDir), name);
    // the entry runs from the read-only code directory (R30), which the kernel reviews (R31)
    const codeDir = join(serviceCodeRoot(this.o.deviceDir), name);
    const r = this.running.get(name);
    // a running one names the files it runs, so the kernel can review a start on new ones
    return r
      ? {
          name,
          state: "running",
          startedAt: r.startedAt,
          stateDir,
          codeDir,
          ...(r.filesDigest !== undefined && { filesDigest: r.filesDigest }),
        }
      : { name, state: "stopped", startedAt: null, stateDir, codeDir };
  }

  /** Resolves once the service's current process is gone (now, when none runs). */
  async exited(name: string): Promise<void> {
    await this.running.get(name)?.gone;
  }

  /**
   * Starts the service, or finds it running. A running service started with another network is
   * restarted with the requested one (controller ruling R14): the sandbox's network grant is fixed
   * when the worker starts and cannot be changed in place, so hosts approved later reach the
   * service only through a restart (its state directory, a browser profile included, persists).
   * So is one running other code than the ensure names (its `filesDigest`, else the digest of its
   * files): an upgraded extension's service runs its new files from the next ensure on, decided
   * here on the machine that runs it, whichever replica asks. Without the files, a differing
   * digest answers `files_needed` before the running service is stopped.
   * With `ifRunning` a stopped service stays stopped and its stopped status is answered (R15).
   * Ensures of one name run one after another under an internal signal; `signal` bounds only
   * this caller's wait, so a cancelled caller never fails another's start.
   */
  ensure(
    spec: LocalServiceSpec,
    network: SandboxLimits["network"] | undefined,
    signal: AbortSignal,
    opts: { ifRunning?: boolean; filesDigest?: string } = {},
  ): Promise<DeviceServiceStatus> {
    signal.throwIfAborted();
    // an ifRunning ensure reads only the name (the kernel sends `{ name, entry: "", args: [],
    // files: {} }`): it never starts a service from the request's spec
    if (opts.ifRunning) checkName(spec.name);
    else checkSpec(spec);
    const name = spec.name;
    const run = this.serialize(name, async () => {
      // a process that removed its socket is on its way out: it is not running for this ensure
      await this.settleExiting(name);
      // the effective network now (the owner's ceiling may have narrowed since the start)
      const launcher = this.o.launcher();
      const key = launcher?.networkKey ? await launcher.networkKey(network) : networkKey(network);
      const current = this.running.get(name);
      // the code the ensure names (an ifRunning ensure names none: it keeps the launched code)
      const wanted = opts.ifRunning
        ? undefined
        : (opts.filesDigest ?? (spec.files ? deviceServiceFilesDigest(spec.files) : undefined));
      if (current?.network === key && (wanted === undefined || wanted === current.filesDigest))
        return this.status(name);
      if (!current && opts.ifRunning) return this.status(name);
      // under ifRunning a running service is restarted with the new network from the spec it was
      // launched with (the one the kernel reviewed) and the code already in its code directory,
      // which this restart never touches; otherwise a start follows the request's spec, refused
      // before a running service is stopped when its files are missing
      const launch: LocalServiceSpec | undefined = opts.ifRunning ? current?.spec : spec;
      if (launch === undefined) return this.status(name);
      if (!opts.ifRunning && spec.files === undefined)
        await this.checkStoredDigest(name, opts.filesDigest);
      if (current) {
        current.stopping = true;
        await current.proc.stop(SERVICE_STOP_GRACE_MS);
        await current.gone;
      }
      return this.controlledStart(name, (startSignal) =>
        this.start(launch, network, key, startSignal, {
          ...(opts.ifRunning ? { storedCode: true, runningDigest: current?.filesDigest } : {}),
          ...(opts.filesDigest !== undefined && { filesDigest: opts.filesDigest }),
        }),
      );
    });
    return withSignal(run, signal);
  }

  /** Runs `fn` after the ensure or restart of `name` in flight, as the one in flight now. */
  private serialize<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.starting.get(name);
    const run = (async () => {
      await previous?.catch(() => {});
      return fn();
    })();
    this.starting.set(name, run);
    void run
      .finally(() => {
        if (this.starting.get(name) === run) this.starting.delete(name);
      })
      .catch(() => {});
    return run;
  }

  /** Runs a start under an internal signal that a stop of `name` aborts. */
  private async controlledStart<T>(name: string, fn: (signal: AbortSignal) => Promise<T>) {
    const ctl = new AbortController();
    this.startCtl.set(name, ctl);
    try {
      return await fn(ctl.signal);
    } finally {
      if (this.startCtl.get(name) === ctl) this.startCtl.delete(name);
    }
  }

  /**
   * A running service whose socket is gone is stopping on its own (it removes its socket first and
   * exits a moment later): waits up to {@link SERVICE_EXITING_GRACE_MS} for the process to exit,
   * then stops it, so the name is free for a fresh start. Called only under {@link serialize}.
   */
  private async settleExiting(name: string): Promise<void> {
    const r = this.running.get(name);
    if (!r || (await isSocket(join(serviceRoot(this.o.deviceDir), name, SOCKET_NAME)))) return;
    const graceMs = this.o.exitingGraceMs ?? SERVICE_EXITING_GRACE_MS;
    let timer: NodeJS.Timeout | undefined;
    const exited = await Promise.race([
      r.gone.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), graceMs);
      }),
    ]);
    clearTimeout(timer);
    if (exited) return;
    // it was stopping on its own: still not a stop by this program, so a request revives it
    await r.proc.stop(SERVICE_STOP_GRACE_MS);
    await r.gone;
  }

  /**
   * Starts again a service that a connection found without its socket (`was`, the record it
   * found): once the old process is gone, the spec it was launched with runs on the code already
   * in its code directory, as an `ifRunning` restart does. A service this program stopped stays
   * stopped; one another caller started meanwhile is answered as it is.
   */
  private revive(name: string, was: Running): Promise<Running> {
    return this.serialize(name, async () => {
      await this.settleExiting(name);
      const current = this.running.get(name);
      if (current) return current;
      if (was.stopping) throw new ServiceNotRunningError(name);
      const launcher = this.o.launcher();
      const key = launcher?.networkKey
        ? await launcher.networkKey(was.launchNetwork)
        : networkKey(was.launchNetwork);
      await this.controlledStart(name, (startSignal) =>
        this.start({ ...was.spec }, was.launchNetwork, key, startSignal, {
          storedCode: true,
          runningDigest: was.filesDigest,
        }),
      );
      const started = this.running.get(name);
      if (!started) throw new ServiceNotRunningError(name);
      return started;
    });
  }

  async stop(name: string, signal: AbortSignal, graceMs = SERVICE_STOP_GRACE_MS): Promise<void> {
    this.startCtl.get(name)?.abort(new Error(`The device service ${name} was stopped`));
    await this.starting.get(name)?.catch(() => {});
    const r = this.running.get(name);
    if (!r) return;
    signal.throwIfAborted();
    r.stopping = true;
    await r.proc.stop(graceMs);
    await r.gone;
  }

  /**
   * Stops (never restarts) every running service whose grant no longer holds: its effective
   * network ({@link ServiceLauncher.networkKey} of the network it was launched with) or the owner
   * ceiling revision changed since its launch, or either cannot be read now (fail closed). Called
   * with every owner reconcile (the connection's periodic policy check): a sandbox grant is fixed
   * when the worker starts, so a narrowed ceiling must end the process, and the next `ensure`
   * starts it again under the new one. A service whose start is in flight is left to that start.
   */
  async reconcile(signal: AbortSignal): Promise<void> {
    const launcher = this.o.launcher();
    const stale: string[] = [];
    for (const [name, r] of this.running) {
      if (this.starting.has(name)) continue;
      let holds = false;
      try {
        const key = launcher?.networkKey
          ? await launcher.networkKey(r.launchNetwork)
          : networkKey(r.launchNetwork);
        const revision = launcher?.ceilingRevision ? await launcher.ceilingRevision() : undefined;
        holds = key === r.network && revision === r.proc.ceilingRevision;
      } catch {
        holds = false;
      }
      if (!holds && this.running.get(name) === r) stale.push(name);
    }
    signal.throwIfAborted();
    await Promise.all(
      stale.map(async (name) => {
        const r = this.running.get(name);
        if (!r || this.starting.has(name)) return;
        r.stopping = true;
        await r.proc.stop(SERVICE_STOP_GRACE_MS);
        await r.gone;
      }),
    );
  }

  /** Stops every service (a new instance, a machine stop, the program's end). */
  async stopAll(signal: AbortSignal): Promise<void> {
    for (const ctl of this.startCtl.values()) ctl.abort(new Error("Device services were stopped"));
    await Promise.allSettled([...this.starting.values()]);
    await Promise.all([...this.running.keys()].map((name) => this.stop(name, signal)));
  }

  /**
   * One `request` connection: sends `body`, resolves the service's one answer. Throws when the
   * service is not running, on timeout and on abort.
   */
  async request(
    name: string,
    body: Uint8Array,
    opts: { timeoutMs: number; signal: AbortSignal },
  ): Promise<Uint8Array> {
    const conn = await this.connect(name, "request", opts.signal);
    return new Promise<Uint8Array>((resolve, reject) => {
      const decoder = new ServiceMessageDecoder();
      let settled = false;
      const finish = (error: Error | undefined, value?: Uint8Array) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        opts.signal.removeEventListener("abort", onAbort);
        conn.destroy();
        if (error) reject(error);
        else resolve(value as Uint8Array);
      };
      const timer = setTimeout(
        () =>
          finish(
            new Error(
              `The device service ${name} did not answer within ${opts.timeoutMs} ms; retry or raise the timeout`,
            ),
          ),
        opts.timeoutMs,
      );
      const onAbort = () =>
        finish(opts.signal.reason instanceof Error ? opts.signal.reason : new Error("aborted"));
      opts.signal.addEventListener("abort", onAbort, { once: true });
      conn.on("data", (chunk: Buffer) => {
        try {
          const [first] = decoder.push(chunk);
          if (first) finish(undefined, first);
        } catch (error) {
          finish(error as Error);
        }
      });
      conn.on("error", (error) => finish(error));
      conn.on("close", () =>
        finish(new Error(`The device service ${name} closed the connection without an answer`)),
      );
      try {
        conn.write(encodeServiceMessage(body));
      } catch (error) {
        finish(error as Error);
      }
    });
  }

  /**
   * Opens a `stream` connection for a dial-in stream whose open body is `{ service }`; the target
   * is always a running service of this device, never another socket.
   */
  async openStream(body: unknown, signal: AbortSignal): Promise<Socket> {
    if (
      typeof body !== "object" ||
      body === null ||
      Object.keys(body).length !== 1 ||
      typeof (body as { service?: unknown }).service !== "string"
    )
      throw new ServiceSpecError("Open a device stream with { service } naming a device service");
    const name = (body as { service: string }).service;
    if (!DEVICE_SERVICE_ID_RE.test(name))
      throw new ServiceSpecError(`Invalid device service id: ${name}`);
    return this.connect(name, "stream", signal);
  }

  /**
   * Connects to a running service's socket and sends the connection's kind. A start in flight is
   * waited for first. A socket that is gone (or refuses) while the process still runs means the
   * service is stopping on its own: it is started again once that process exited
   * ({@link revive}), and the connection goes to the fresh one.
   */
  private async connect(
    name: string,
    kind: "request" | "stream",
    signal: AbortSignal,
  ): Promise<Socket> {
    signal.throwIfAborted();
    const inFlight = this.starting.get(name);
    if (inFlight)
      await withSignal(
        inFlight.catch(() => {}),
        signal,
      );
    const r = this.running.get(name);
    if (!r) throw new ServiceNotRunningError(name);
    let conn: Socket;
    try {
      conn = await this.dial(r, signal);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ECONNREFUSED") throw error;
      conn = await this.dial(await withSignal(this.revive(name, r), signal), signal);
    }
    conn.write(encodeServiceMessage(Buffer.from(JSON.stringify({ kind }))));
    return conn;
  }

  /** Opens a connection to the socket of `r`, tracked until it closes. */
  private async dial(r: Running, signal: AbortSignal): Promise<Socket> {
    signal.throwIfAborted();
    const conn = await new Promise<Socket>((resolve, reject) => {
      const c = createConnection(r.socket);
      const onAbort = () => {
        c.destroy();
        reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      c.once("connect", () => {
        signal.removeEventListener("abort", onAbort);
        resolve(c);
      });
      c.once("error", (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      });
    });
    r.conns.add(conn);
    conn.once("close", () => r.conns.delete(conn));
    return conn;
  }

  private async start(
    spec: LocalServiceSpec,
    network: SandboxLimits["network"] | undefined,
    key: string,
    signal: AbortSignal,
    /**
     * `storedCode`: a restart of a running service (a network change under `ifRunning`) on the
     * code already in its code directory, which it was launched from; nothing there is checked
     * against a digest or written.
     */
    o: { filesDigest?: string; storedCode?: boolean; runningDigest?: string | undefined },
  ): Promise<DeviceServiceStatus> {
    const filesDigest = o.filesDigest;
    const launcher = this.o.launcher();
    if (!launcher)
      throw new SandboxPermissionUnsupportedError(
        "Device services need a macOS host device in this version of capybara-device",
      );
    await this.pruneLegacy();
    const paths = servicePaths(this.o.deviceDir, spec.name, this.aliasRoot);
    // every directory and file written here is checked component by component and never through
    // a link: the state directory is the service's own write root, the workspace the agent's
    const stateDir = await realDirectory(this.o.deviceDir, ["svc", spec.name]);
    const downloads = await realDirectory(this.o.workspace, ["downloads"]);
    const tmpDir = await realDirectory(stateDir, [TMP_NAME]);
    // the code lives apart from the state: `<device dir>/svc-files/<name>`, written only here
    const codeDir = await realDirectory(this.o.deviceDir, ["svc-files", spec.name]);
    // files are (re)written on start only; the state directory is the service's own and kept (a
    // browser profile)
    if (o.storedCode) {
      // only this program writes the code directory, and nothing since this service's launch
    } else if (spec.files === undefined) {
      // checked again at the start itself (after a stop, or a concurrent writer)
      const stored = await readStoredDigest(codeDir);
      if (stored === undefined || stored !== filesDigest)
        throw new ServiceFilesNeededError(spec.name, "the stored files changed");
    } else {
      // the code directory holds exactly the spec's files and the digest they were sent under:
      // everything else goes first (never through a link: rm removes a link itself)
      for (const entry of await readdir(codeDir))
        await rm(join(codeDir, entry), { recursive: true, force: true });
      for (const [rel, content] of Object.entries(spec.files)) {
        const parts = rel.split("/");
        const dir = await realDirectory(codeDir, parts.slice(0, -1));
        await writeNewFile(join(dir, parts[parts.length - 1] as string), content);
      }
      if (filesDigest !== undefined)
        await writeNewFile(join(codeDir, DIGEST_NAME), Buffer.from(filesDigest));
    }
    // what the service installed once (a browser): read only once it sealed it, emptied when
    // its files change; a restart on stored code keeps it as it is. A service that names its
    // install key gets it from the machine-wide cache instead, keyed by that
    const installKey = this.o.installCache
      ? await readSmallFile(join(codeDir, DEVICE_SERVICE_INSTALL_KEY_FILE))
      : undefined;
    let lease: InstallLease | undefined;
    let install: { dir: string; sealed: boolean };
    let installRoot: string;
    if (this.o.installCache && validInstallKey(installKey)) {
      lease = await this.o.installCache.acquire(
        spec.name,
        installKey,
        signal,
        this.o.launcher()?.installVariant?.() ?? "",
      );
      install = { dir: lease.dir, sealed: lease.sealed };
      installRoot = this.o.installCache.root;
      // the device's own copy from before the cache is not used any more
      await this.dropDeviceInstall(spec.name);
    } else {
      install = await this.installDir(
        spec.name,
        o.storedCode
          ? null
          : (filesDigest ?? (spec.files ? deviceServiceFilesDigest(spec.files) : null)),
      );
      installRoot = serviceInstallRoot(this.o.deviceDir);
    }
    try {
      return await this.launchWith(spec, network, key, signal, {
        ...o,
        paths,
        stateDir,
        downloads,
        tmpDir,
        codeDir,
        install,
        installRoot,
        lease,
      });
    } catch (error) {
      // a launch that never ran (or whose process is gone already) gives its install back
      if (lease && !this.running.has(spec.name)) await lease.release();
      throw error;
    }
  }

  /** The launch of {@link start}, once every directory was made and the install resolved. */
  private async launchWith(
    spec: LocalServiceSpec,
    network: SandboxLimits["network"] | undefined,
    key: string,
    signal: AbortSignal,
    o: {
      filesDigest?: string;
      storedCode?: boolean;
      runningDigest?: string | undefined;
      paths: ReturnType<typeof servicePaths>;
      stateDir: string;
      downloads: string;
      tmpDir: string;
      codeDir: string;
      install: { dir: string; sealed: boolean };
      installRoot: string;
      lease: InstallLease | undefined;
    },
  ): Promise<DeviceServiceStatus> {
    const { filesDigest, paths, stateDir, downloads, tmpDir, codeDir, install, lease } = o;
    const launcher = this.o.launcher();
    if (!launcher)
      throw new SandboxPermissionUnsupportedError(
        "Device services need a macOS host device in this version of capybara-device",
      );
    // a socket left by an earlier run would make the bind fail
    await removeEntry(join(stateDir, SOCKET_NAME));
    if (paths.alias) await this.makeAlias(paths.alias, stateDir);
    const env: Record<string, string> = {
      ...spec.env,
      [DEVICE_SERVICE_SOCKET_ENV]: paths.socket,
      [DEVICE_SERVICE_STATE_ENV]: stateDir,
      [DEVICE_SERVICE_INSTALL_ENV]: install.dir,
      // resolved, as the service's grant names it
      [DEVICE_SERVICE_WORKSPACE_ENV]: await realpath(this.o.workspace),
    };
    await this.o.beforeLaunch?.();
    // the workspace is writable by concurrent sandboxed operations: downloads may have been
    // swapped for a link since it was checked, so the grant takes the resolved paths, each still
    // strictly inside its parent (the workspace, the device's service root)
    const realState = await resolvedInside(stateDir, serviceRoot(this.o.deviceDir));
    const realDownloads = await resolvedInside(downloads, this.o.workspace);
    const realCode = await resolvedInside(codeDir, serviceCodeRoot(this.o.deviceDir));
    const realInstall = await resolvedInside(install.dir, o.installRoot);
    const proc = await launcher.launch(
      {
        name: spec.name,
        // the code directory exactly as the status reports it (the kernel reviews that path); it
        // was checked link-free above and resolves inside the code root
        argv: [process.execPath, join(codeDir, spec.entry), ...spec.args],
        cwd: stateDir,
        env,
        stateDir,
        writeRoots: [realState, realDownloads, ...(install.sealed ? [] : [realInstall])],
        // the code directory is read only: it is never a write root; so is a sealed install
        readRoots: [
          nodeDirectory(),
          realCode,
          ...(install.sealed ? [realInstall] : []),
          this.o.workspace,
          ...(paths.alias ? [paths.alias] : []),
        ],
        unixSockets: [realState, ...(paths.alias ? [paths.alias] : [])],
        tmpDir,
        ...(network && { network }),
      },
      signal,
    );
    const { files: _files, ...launched } = spec;
    const record: Running = {
      proc,
      network: key,
      launchNetwork: network,
      spec: launched,
      filesDigest: o.storedCode
        ? o.runningDigest
        : (filesDigest ?? (spec.files ? deviceServiceFilesDigest(spec.files) : undefined)),
      startedAt: this.now().toISOString(),
      socket: paths.socket,
      conns: new Set(),
      gone: proc.exited.then(
        () => {},
        () => {},
      ),
      stopping: false,
    };
    let exited = false;
    record.gone = record.gone.then(async () => {
      exited = true;
      for (const c of record.conns) c.destroy();
      // published (or let go) before the name is free: the next start finds the sealed install
      await lease?.release();
      if (this.running.get(spec.name) === record) this.running.delete(spec.name);
      if (paths.alias) await this.removeAlias(paths.alias, stateDir).catch(() => {});
    });
    this.running.set(spec.name, record);
    try {
      await waitForSocket(join(stateDir, SOCKET_NAME), {
        timeoutMs: this.o.readyTimeoutMs ?? SERVICE_READY_TIMEOUT_MS,
        signal,
        exited: () => exited,
      });
    } catch (error) {
      await proc.stop(0).catch(() => {});
      await record.gone;
      const tail = proc.output().trim().slice(-1000);
      throw new Error(
        `The device service ${spec.name} did not start: ${(error as Error).message}${tail ? `; its output ends: ${tail}` : ""}`,
      );
    }
    return this.status(spec.name);
  }

  /**
   * The service's install directory (`<device dir>/svc-install/<id>`, made link-free) and whether
   * this launch gets it read only: sealed (the service made the regular file
   * {@link DEVICE_SERVICE_INSTALL_SEAL} in it) and filled under `digest`. Anything else is emptied
   * and the launch gets it writable: an unsealed directory holds nothing trustworthy (an earlier
   * process, an older version of the service, may have written anything there), so every unsealed
   * start installs afresh. `digest` null (a restart on the stored code) keeps a sealed directory
   * and empties an unsealed one.
   */
  private async installDir(
    name: string,
    digest: string | null,
  ): Promise<{ dir: string; sealed: boolean }> {
    const root = await realDirectory(this.o.deviceDir, ["svc-install"]);
    const dir = await realDirectory(root, [name]);
    const sealed = await isRegularFile(join(dir, DEVICE_SERVICE_INSTALL_SEAL));
    const record = join(root, `.${name}`);
    const recorded = await readSmallFile(record);
    if (sealed && (digest === null || recorded === digest)) return { dir, sealed: true };
    // never through a link: rm removes a link itself
    for (const entry of await readdir(dir))
      await rm(join(dir, entry), { recursive: true, force: true });
    if (digest !== null && recorded !== digest) await writeNewFile(record, Buffer.from(digest));
    return { dir, sealed: false };
  }

  /**
   * Empties `<device dir>/svc-install/<id>` and drops its record: the install of a service that
   * moved to the machine-wide cache (never through a link: rm removes a link itself).
   */
  private async dropDeviceInstall(name: string): Promise<void> {
    const root = await realDirectory(this.o.deviceDir, ["svc-install"]);
    await rm(join(root, name), { recursive: true, force: true });
    await rm(join(root, `.${name}`), { force: true });
  }

  /**
   * Removes what services kept under bare names before ids (core#817): an entry of `svc/` or
   * `svc-files/` whose name is not a service id (an old browser profile with its cookies, old
   * code), once per device directory (the `.ids-v1` record). Never through a link (rm removes a
   * link itself); records (`.`-names) are left alone.
   */
  private async pruneLegacy(): Promise<void> {
    // once per device directory: a later change of the id rule never wipes what ids keep
    const svc = await realDirectory(this.o.deviceDir, ["svc"]);
    const marker = join(svc, LEGACY_PRUNED_MARKER);
    if (await isRegularFile(marker)) return;
    for (const root of [serviceRoot(this.o.deviceDir), serviceCodeRoot(this.o.deviceDir)]) {
      let entries: string[];
      try {
        entries = await readdir(root);
      } catch {
        continue;
      }
      for (const entry of entries)
        if (!entry.startsWith(".") && !DEVICE_SERVICE_ID_RE.test(entry))
          await rm(join(root, entry), { recursive: true, force: true });
    }
    await writeNewFile(marker, Buffer.from("1\n"));
  }

  /** Refuses a start without files unless the stored files were written under `digest`. */
  private async checkStoredDigest(name: string, digest: string | undefined): Promise<void> {
    if (digest === undefined) throw new ServiceFilesNeededError(name, "no files and no digest");
    const codeDir = await realDirectory(this.o.deviceDir, ["svc-files", name]);
    const stored = await readStoredDigest(codeDir);
    if (stored === undefined) throw new ServiceFilesNeededError(name, "no files are stored");
    if (stored !== digest)
      throw new ServiceFilesNeededError(name, "the stored files have another digest");
  }

  /** The alias of {@link servicePaths}: a link in this program's own 0700 directory. */
  private async makeAlias(alias: string, stateDir: string): Promise<void> {
    await mkdir(this.aliasRoot, { recursive: true, mode: 0o700 });
    const root = await lstat(this.aliasRoot);
    if (
      !root.isDirectory() ||
      (process.getuid && root.uid !== process.getuid()) ||
      (root.mode & 0o077) !== 0
    )
      throw new Error(
        `The service socket alias root ${this.aliasRoot} is not a private directory of this user; remove it and retry`,
      );
    try {
      const st = await lstat(alias);
      if (st.isSymbolicLink() && (await readlink(alias)) === stateDir) return;
      await unlink(alias);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await symlink(stateDir, alias);
  }

  /** Removes the alias once its service is gone (only when it is still this service's link). */
  private async removeAlias(alias: string, stateDir: string): Promise<void> {
    const st = await lstat(alias);
    if (st.isSymbolicLink() && (await readlink(alias)) === stateDir) await unlink(alias);
  }
}

/**
 * The directory holding the Node runtime the service runs with (`process.execPath` resolved):
 * the narrowest read root that reaches it. The launcher checks it against the owner's ceiling.
 */
function nodeDirectory(): string {
  return dirname(realpathSync(process.execPath));
}

/**
 * The digest the code directory's files were written under ({@link readSmallFile}); anything
 * that is not a digest counts as none.
 */
async function readStoredDigest(codeDir: string): Promise<string | undefined> {
  const text = await readSmallFile(join(codeDir, DIGEST_NAME));
  return text !== undefined && FILES_DIGEST_RE.test(text) ? text : undefined;
}

/**
 * A small record file, trimmed: opened without following a link and without blocking (a FIFO),
 * read only from a regular file and at most 257 bytes (a longer or growing file counts as none);
 * anything else counts as none.
 */
async function readSmallFile(path: string): Promise<string | undefined> {
  let fh: Awaited<ReturnType<typeof open>>;
  try {
    fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return undefined;
  }
  try {
    if (!(await fh.stat()).isFile()) return undefined;
    const buf = Buffer.alloc(257);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    if (bytesRead > 256) return undefined;
    return buf.subarray(0, bytesRead).toString("utf8").trim();
  } finally {
    await fh.close();
  }
}

/** Whether `path` is a regular file itself (a link to one is not). */
/** Whether `path` is a socket now (false when it is missing). */
async function isSocket(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isSocket();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch {
    return false;
  }
}

function checkName(name: string): void {
  if (!DEVICE_SERVICE_ID_RE.test(name))
    throw new ServiceSpecError(
      `Invalid device service id ${JSON.stringify(name)}: <extension>.<name> (${DEVICE_SERVICE_ID_RE})`,
    );
}

function checkSpec(spec: LocalServiceSpec): void {
  checkName(spec.name);
  const files = spec.files ?? {};
  for (const rel of Object.keys(files)) checkRelativePath(rel, "A service file path");
  checkRelativePath(spec.entry, "The service entry");
  if (spec.files !== undefined && !(spec.entry in spec.files))
    throw new ServiceSpecError(`The service entry ${spec.entry} is not one of its files`);
  for (const rel of Object.keys(files)) {
    const first = rel.split("/")[0];
    // the code directory holds the digest beside the files
    if (first === DIGEST_NAME)
      throw new ServiceSpecError(
        `The service file ${rel} uses a name the device reserves in the code directory (${DIGEST_NAME})`,
      );
  }
  for (const key of Object.keys(spec.env ?? {}))
    if (
      key === DEVICE_SERVICE_SOCKET_ENV ||
      key === DEVICE_SERVICE_STATE_ENV ||
      key === DEVICE_SERVICE_WORKSPACE_ENV
    )
      throw new ServiceSpecError(`${key} is set by the device; leave it out of the service env`);
}

/** Waits until the service created its socket, it exited, the time ran out or `signal` aborted. */
async function waitForSocket(
  path: string,
  o: { timeoutMs: number; signal: AbortSignal; exited: () => boolean },
): Promise<void> {
  const deadline = Date.now() + o.timeoutMs;
  for (;;) {
    o.signal.throwIfAborted();
    if (o.exited()) throw new Error("it exited before it listened on its socket");
    try {
      if ((await stat(path)).isSocket()) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (Date.now() >= deadline)
      throw new Error(`it did not listen on its socket within ${o.timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
