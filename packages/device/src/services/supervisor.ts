import { createHash } from "node:crypto";
import { lstat, mkdir, readlink, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { dirname, isAbsolute, join, normalize } from "node:path";
import {
  DEVICE_SERVICE_NAME_RE,
  DEVICE_SERVICE_SOCKET_ENV,
  DEVICE_SERVICE_STATE_ENV,
  type DeviceServiceStatus,
  encodeServiceMessage,
  type SandboxLimits,
  SandboxPermissionUnsupportedError,
  ServiceMessageDecoder,
} from "@capybara-hq/plugin-sdk";

/**
 * The longest unix socket path a service is given, in bytes: macOS's `sun_path` holds 104 bytes
 * including the terminating NUL (Linux's 108), so 103 fits both.
 */
export const MAX_SERVICE_SOCKET_PATH_BYTES = 103;

/** The socket's file name inside the state directory: one byte, to leave room for the path. */
const SOCKET_NAME = "s";

/** How long a started service has to create its socket before the start fails. */
export const SERVICE_READY_TIMEOUT_MS = 15_000;

/** How long a stopped service gets to exit on its own before it is killed. */
export const SERVICE_STOP_GRACE_MS = 2_000;

/** The device's service state root: `<device dir>/svc`, outside every workspace and project. */
export const serviceRoot = (deviceDir: string) => join(deviceDir, "svc");

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
  /** Written into the state directory before start, keyed by relative path. */
  files: Record<string, Uint8Array>;
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
  /** Exactly the state directory and `<workspace>/downloads`. */
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
}

/** A service's request or stream connection could not be served. */
export class ServiceNotRunningError extends Error {
  constructor(name: string) {
    super(`The device service ${name} is not running; start it with ensureService first`);
    this.name = "ServiceNotRunningError";
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
  startedAt: string;
  socket: string;
  /** The connections this program opened to the service; ended when it exits. */
  conns: Set<Socket>;
  /** Resolves when the process is gone and the record is cleared. */
  gone: Promise<void>;
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
  now?: () => Date;
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
 * writing only in its state directory and `<workspace>/downloads`. `ensure` starts a service that
 * is not running (its files are written then, and only then) and is a no-op for a running one; a
 * service that exits stays stopped until the next `ensure` (never restarted automatically). This
 * program is one process per device, so the table lives in its memory: a service is a child of
 * the launcher's worker and ends with this program.
 */
export class ServiceSupervisor {
  private readonly running = new Map<string, Running>();
  private readonly starting = new Map<string, Promise<DeviceServiceStatus>>();
  private readonly aliasRoot: string;
  private readonly now: () => Date;

  constructor(private readonly o: ServiceSupervisorOptions) {
    this.aliasRoot = o.socketAliasRoot ?? defaultSocketAliasRoot();
    this.now = o.now ?? (() => new Date());
  }

  status(name: string): DeviceServiceStatus {
    const r = this.running.get(name);
    return r
      ? { name, state: "running", startedAt: r.startedAt }
      : { name, state: "stopped", startedAt: null };
  }

  /** Resolves once the service's current process is gone (now, when none runs). */
  async exited(name: string): Promise<void> {
    await this.running.get(name)?.gone;
  }

  ensure(
    spec: LocalServiceSpec,
    network: SandboxLimits["network"] | undefined,
    signal: AbortSignal,
  ): Promise<DeviceServiceStatus> {
    signal.throwIfAborted();
    checkSpec(spec);
    if (this.running.has(spec.name)) return Promise.resolve(this.status(spec.name));
    const pending = this.starting.get(spec.name);
    if (pending) return pending;
    const start = this.start(spec, network, signal).finally(() => this.starting.delete(spec.name));
    this.starting.set(spec.name, start);
    return start;
  }

  async stop(name: string, signal: AbortSignal, graceMs = SERVICE_STOP_GRACE_MS): Promise<void> {
    await this.starting.get(name)?.catch(() => {});
    const r = this.running.get(name);
    if (!r) return;
    signal.throwIfAborted();
    await r.proc.stop(graceMs);
    await r.gone;
  }

  /** Stops every service (a new instance, a machine stop, the program's end). */
  async stopAll(signal: AbortSignal): Promise<void> {
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
    if (!DEVICE_SERVICE_NAME_RE.test(name))
      throw new ServiceSpecError(`Invalid device service name: ${name}`);
    return this.connect(name, "stream", signal);
  }

  /** Connects to a running service's socket and sends the connection's kind. */
  private async connect(
    name: string,
    kind: "request" | "stream",
    signal: AbortSignal,
  ): Promise<Socket> {
    signal.throwIfAborted();
    const r = this.running.get(name);
    if (!r) throw new ServiceNotRunningError(name);
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
    conn.write(encodeServiceMessage(Buffer.from(JSON.stringify({ kind }))));
    return conn;
  }

  private async start(
    spec: LocalServiceSpec,
    network: SandboxLimits["network"] | undefined,
    signal: AbortSignal,
  ): Promise<DeviceServiceStatus> {
    const launcher = this.o.launcher();
    if (!launcher)
      throw new SandboxPermissionUnsupportedError(
        "Device services need a macOS host device in this version of capybara-device",
      );
    const paths = servicePaths(this.o.deviceDir, spec.name, this.aliasRoot);
    const { stateDir } = paths;
    const downloads = join(this.o.workspace, "downloads");
    const tmpDir = join(stateDir, "tmp");
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    await mkdir(tmpDir, { recursive: true, mode: 0o700 });
    await mkdir(downloads, { recursive: true });
    // files are (re)written on start only; everything else in the state directory is kept (the
    // service's own state, a browser profile)
    for (const [rel, content] of Object.entries(spec.files)) {
      const file = join(stateDir, rel);
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      await writeFile(file, content, { mode: 0o600 });
    }
    // a socket left by an earlier run would make the bind fail
    await rm(join(stateDir, SOCKET_NAME), { force: true });
    if (paths.alias) await this.makeAlias(paths.alias, stateDir);
    const env: Record<string, string> = {
      ...spec.env,
      [DEVICE_SERVICE_SOCKET_ENV]: paths.socket,
      [DEVICE_SERVICE_STATE_ENV]: stateDir,
    };
    const proc = await launcher.launch(
      {
        name: spec.name,
        argv: [process.execPath, join(stateDir, spec.entry), ...spec.args],
        cwd: stateDir,
        env,
        stateDir,
        writeRoots: [stateDir, downloads],
        readRoots: [nodePrefix(), this.o.workspace, ...(paths.alias ? [paths.alias] : [])],
        unixSockets: [stateDir, ...(paths.alias ? [paths.alias] : [])],
        tmpDir,
        ...(network && { network }),
      },
      signal,
    );
    const record: Running = {
      proc,
      startedAt: this.now().toISOString(),
      socket: paths.socket,
      conns: new Set(),
      gone: proc.exited.then(
        () => {},
        () => {},
      ),
    };
    let exited = false;
    record.gone = record.gone.then(() => {
      exited = true;
      if (this.running.get(spec.name) === record) this.running.delete(spec.name);
      for (const c of record.conns) c.destroy();
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
}

/** The Node installation the service runs from (`<prefix>/bin/node`): read by the service. */
function nodePrefix(): string {
  return dirname(dirname(process.execPath));
}

function checkSpec(spec: LocalServiceSpec): void {
  if (!DEVICE_SERVICE_NAME_RE.test(spec.name))
    throw new ServiceSpecError(
      `Invalid device service name ${JSON.stringify(spec.name)}: 1 to 32 characters, a lower-case letter then letters, digits and -`,
    );
  for (const rel of Object.keys(spec.files)) checkRelativePath(rel, "A service file path");
  checkRelativePath(spec.entry, "The service entry");
  if (!(spec.entry in spec.files))
    throw new ServiceSpecError(`The service entry ${spec.entry} is not one of its files`);
  for (const key of Object.keys(spec.env ?? {}))
    if (key === DEVICE_SERVICE_SOCKET_ENV || key === DEVICE_SERVICE_STATE_ENV)
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
