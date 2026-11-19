import { AsyncLocalStorage } from "node:async_hooks";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  defineExtension,
  type ExecResult,
  FileSystemGoneError,
  type FileSystemHandle,
  parseSandboxBrowseScope,
  parseSandboxExecutionRef,
  parseSandboxOperationRef,
  parseSandboxOperationScope,
  parseSandboxPreparationScope,
  SANDBOX_EXTENSION_POINT,
  SANDBOX_TAG_RE,
  type SandboxBackground,
  type SandboxExecutionRef,
  type SandboxExecutionStatus,
  type SandboxFileScope,
  SandboxGoneError,
  type SandboxHandle,
  type SandboxLimits,
  type SandboxOperation,
  SandboxOperationOutcomeUnknownError,
  type SandboxPermissionSupport,
  SandboxPermissionUnsupportedError,
  type SandboxProvider,
  SandboxScopeDeniedError,
  type SandboxStopResult,
  validateSandboxPathShape,
} from "@capybara-hq/plugin-sdk";
import { z } from "zod";

/**
 * Test `sandbox@2` (for tests only, never for production: it has **no isolation** and runs the
 * commands tests write on the host).
 *
 * The "provider side" lives under the deployment config `root` (like a Docker daemon: kernel
 * replicas sharing one root share the same file systems and instances):
 * - `root/filesystems/<fsId>/{workspace,skills}` and `meta.json` (`{ name, limits }`): an
 *   device's files, kept until `destroyFileSystem`; `createFileSystem` on a name that exists
 *   returns the existing one; `create` on a missing file system throws `FileSystemGoneError`
 *   ({@link removeFakeFileSystem} simulates the loss);
 * - `root/instances/<id>/{state,meta.json,tmp,procs,sessions,groups}`: an instance mounts its file
 *   system's `workspace` / `skills` as `/workspace` / `/skills` and its own `tmp` as `/tmp`;
 *   `state` is `running` / `suspended`; `meta.json` = `{ name, image | null, fileSystem, limits }`
 *   as `create` got them; `destroy` drops the instance and keeps the file system;
 * - `root/ops.log`: one line per operation, `<op> <id> [...]`: `create <id> <name>`, `resume`,
 *   `resume-gone`, `suspend`, `destroy`, `destroy-by-name <name>`, `autostart`, `create-fs <fsId>
 *   <name>`, `destroy-fs <fsId>`, `destroy-fs-by-name <name>`, `kill-all <id>`, `kill-tagged <id>
 *   <tag,…>`, and for every finished exec `exec <id> <tag> <startMs> <endMs> <accountId>
 *   <conversationId>` (tests count operations and check overlaps and actors);
 * - a missing instance makes exec / readFile / writeFile / stat / killAll / killTagged throw
 *   `SandboxGoneError` and `resume` return `gone` ({@link removeFakeSandbox}); a suspended one is
 *   started first (the contract's auto-start, logged as `autostart`);
 * - `root/instances/<id>/procs/<pid>`: running exec commands (process group id), content = the
 *   holder tag; `killAll` kills them all, `killTagged` only those with one of the tags;
 * - `root/delays.json` (optional): `{ create?, resume?, suspend?, destroy?, exec?, update? }` in ms, slow
 *   operations (read at each operation, abortable); `exec` holds the command open before it starts;
 * - `root/fs-ids-by-name` (optional, {@link setFakeFileSystemIdsByName}): `createFileSystem` gives
 *   a new file system the id `fs-<name>`, as sandbox-docker names its volumes, so a file system
 *   destroyed and made again under the same name comes back with the same id;
 * - `root/fault.json` (optional, {@link setFakeSandboxFault}): every provider method throws the
 *   network error it names, as a provider whose endpoint is down does (read at each call);
 * - `root/bin`: node shims for `setsid`, `timeout`, `pgrep -s` and `pkill -s` (background tasks,
 *   spec 2026-11-05-background-bash-design §4.2), first on every exec's PATH, so the tests also run
 *   on macOS, which has no `setsid` or `timeout`. A shim session is a process group: `setsid` starts
 *   its command in a new session (whose process group has the session's id) and records
 *   `root/instances/<id>/sessions/<its own pid>` = that id, the pid `echo $!` printed; `timeout`
 *   keeps its command in its group; `pgrep -s` / `pkill -s` resolve a session through that record
 *   only (a sid without one matches nothing; one whose setsid shim is still starting in an exec's
 *   group, recorded in `root/instances/<id>/groups/<pgid>`, is waited for).
 *   The shims are written by {@link createFakeSandbox}, not shipped as files: the plugin package
 *   carries only the entry.
 * - `suspend` and `destroy` kill every process the instance started (exec commands and sessions),
 *   as stopping a container does.
 * - limits (sandbox dev tiers spec §7.1): `updateMode` (deployment config or
 *   {@link FakeSandboxOptions}) gives the provider an `update` that answers `updated` (and records
 *   the new limits in the instance's `meta.json`), `recreate`, or fails (`throw`); `none` (the default) has no
 *   `update`. `limitsApplyAt` is declared as given. Every limits a `create-fs`, `create` or
 *   `update` got is appended to `root/limits.log` ({@link readFakeSandboxLimits}); an `update`
 *   also logs `update <id> <answer>` in `ops.log`.
 * - `list` (deployment config or {@link FakeSandboxOptions}; off by default, so the fake offers no
 *   projects unless a test asks): lists one directory as `SandboxProvider.list` does, with the
 *   instance's directories mapped as for `readFile`, and adds a `scan` that suggests nothing.
 * - `root/refuse-open-egress` (optional, {@link setFakeSandboxRefuseOpenEgress}; read at each
 *   call): like sandbox-docker with `refuseOpenNetwork: true`, limits with the open public
 *   network make `create`, `update` and (with `limitsApplyAt: "fileSystem"`)
 *   `createFileSystem` throw an ordinary error whose message carries {@link FAKE_REFUSAL_SECRET},
 *   so tests can check that it never reaches the model.
 *
 * - the permission-scoped surface (`permissionSupport`, `operation`, `prepare`, `browse` with
 *   `list`, `revokeOperation`, `background`; see {@link managedSurface}): restricted and Full
 *   access with background ownership by default ({@link FAKE_PERMISSION_SUPPORT};
 *   `root/permission-support.json` overrides it, {@link setFakeSandboxPermissionSupport}).
 *   While it reports `boundary: "instance"`, `operation` runs only the instance scope, as
 *   sandbox-docker and sandbox-e2b do: a scoped filesystem must name `/` in both its read and
 *   write roots, else `SandboxPermissionUnsupportedError`.
 *   Operation records live in `root/operation-records`, revocation tombstones in
 *   `root/operation-revoked`, background executions in `root/instances/<id>/executions/<hash>`
 *   (`ref.json`, `pgid`, `exit`, `claim`, `lost`); `ops.log` adds `bg-start <id> <operationId>
 *   <pgid>`, `bg-stop <id> <operationId>` and `revoke <id> <operationId>`.
 *
 * `exec` runs the command with `/bin/sh -c` in the instance's directories: `/workspace`, `/skills`
 * and `/tmp` in the command are replaced by their host directories and mapped back in the output;
 * a timeout or an abort kills the whole process group (SIGKILL). An already aborted signal fails an
 * operation at once.
 */

const Deployment = z.object({
  root: z.string().min(1),
  updateMode: z.enum(["updated", "recreate", "throw", "none"]).optional(),
  limitsApplyAt: z.enum(["instance", "fileSystem"]).optional(),
  list: z.boolean().optional(),
});

/** A stand-in for a provider setting in the refusal's message (see the file header). */
export const FAKE_REFUSAL_SECRET = "fake-secret-0c1d2e";

/** How the fake applies new limits (see the file header). */
export interface FakeSandboxOptions {
  /** `update`'s answer (`throw`: it fails with an ordinary error); `none` (default): no `update`. */
  updateMode?: "updated" | "recreate" | "throw" | "none";
  limitsApplyAt?: "instance" | "fileSystem";
  /** Gives the provider a `list` and a `scan` (see the file header). */
  list?: boolean;
}

/** One line of `root/limits.log`: the limits an operation got. */
export interface FakeSandboxLimitsEntry {
  op: "create-fs" | "create" | "update";
  /** The file system id (`create-fs`) or the instance id. */
  id: string;
  limits: SandboxLimits;
}

/** Every limits `create-fs`, `create` and `update` got, oldest first. */
export async function readFakeSandboxLimits(root: string): Promise<FakeSandboxLimitsEntry[]> {
  const text = await readFile(join(root, "limits.log"), "utf8").catch(() => "");
  return text
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as FakeSandboxLimitsEntry);
}

/** 慢操作的延迟（毫秒），写在 `root/delays.json`。 */
export interface FakeSandboxDelays {
  create?: number;
  resume?: number;
  suspend?: number;
  destroy?: number;
  /** Held before the command starts (inside `exec`, so the caller's lease is held meanwhile). */
  exec?: number;
  /** Held inside `update` (only with an `updateMode`). */
  update?: number;
}

/** create 时记下的参数（`root/instances/<id>/meta.json`）。 */
export interface FakeSandboxMeta {
  name: string;
  /** null when `create` got no image. */
  image: string | null;
  /** The id of the file system the instance mounts. */
  fileSystem: string;
  limits: SandboxLimits;
}

const instanceDir = (root: string, id: string) => join(root, "instances", id);
const fileSystemDir = (root: string, id: string) => join(root, "filesystems", id);

/** Ids of the file systems that exist under `root`. */
export async function fakeFileSystems(root: string): Promise<string[]> {
  return (await readdir(join(root, "filesystems")).catch(() => [] as string[])).sort();
}

/**
 * The host directory of `/workspace` of an instance (its file system's `workspace`), for tests
 * that read files directly. Throws when the instance is missing.
 */
export function fakeWorkspaceDir(root: string, instanceId: string): string {
  const meta = JSON.parse(
    readFileSync(join(instanceDir(root, instanceId), "meta.json"), "utf8"),
  ) as FakeSandboxMeta;
  return join(fileSystemDir(root, meta.fileSystem), "workspace");
}

/** Simulates the provider losing a file system (a later `create` throws `FileSystemGoneError`). */
export async function removeFakeFileSystem(root: string, fsId: string): Promise<void> {
  await rm(fileSystemDir(root, fsId), { recursive: true, force: true });
}

/** The env var that tells the shims their instance directory (the session records). */
const INSTANCE_ENV = "CAPYBARA_FAKE_SANDBOX_INSTANCE";

/** Shared by `pgrep` and `pkill`: the live pids of the sessions named by `-s <list>`. */
const SESSION_LOOKUP = `const { execFileSync } = process.getBuiltinModule("node:child_process");
const { existsSync, readFileSync } = process.getBuiltinModule("node:fs");
const { join } = process.getBuiltinModule("node:path");
/**
 * The process group of a session: the record of the setsid shim whose pid it is, else null (no
 * such session: match nothing, as real \`pkill -s\` does). The shim may still be starting
 * (\`echo $!\` returns before it runs): while that pid lives in the process group of one of this
 * instance's execs (\`groups/<pgid>\`), wait for its record. Any other pid is never waited for.
 */
function resolveSession(sid) {
  const dir = process.env.${INSTANCE_ENV};
  if (!dir) return null;
  const end = Date.now() + 5000;
  const record = () => {
    try {
      const pgid = readFileSync(join(dir, "sessions", sid), "utf8").trim();
      return pgid === "" ? null : pgid;
    } catch {
      return null;
    }
  };
  for (;;) {
    const recorded = record();
    if (recorded !== null) return recorded;
    let pgid = "";
    try {
      pgid = execFileSync("ps", ["-o", "pgid=", "-p", sid], { encoding: "utf8" }).trim();
    } catch {}
    // the shim may have written its record and exited since the read above
    if (pgid === "" || !existsSync(join(dir, "groups", pgid))) return record();
    if (Date.now() > end) return null;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
}
function sessionPids(list) {
  const groups = new Set();
  for (const sid of list.split(",")) {
    if (!/^[0-9]+$/.test(sid)) {
      process.stderr.write("invalid session id: " + sid + "\\n");
      process.exit(2);
    }
    const pgid = resolveSession(sid);
    if (pgid !== null) groups.add(pgid);
  }
  const ps = execFileSync("ps", ["-A", "-o", "pid=,pgid=,stat="], { encoding: "utf8" });
  const pids = [];
  for (const line of ps.split("\\n")) {
    const [pid, pgid, stat] = line.trim().split(/\\s+/);
    if (!pid || Number(pid) === process.pid || (stat ?? "").startsWith("Z")) continue;
    if (groups.has(pgid)) pids.push(Number(pid));
  }
  return pids;
}
function usage(name) {
  process.stderr.write(name + ": the sandbox-fake shim supports only " + name + " [-SIGNAL] -s <sid>[,<sid>...]\\n");
  process.exit(2);
}
`;

/** The shims in `root/bin` (see the file header). */
const SHIMS: Record<string, string> = {
  setsid: `#!/usr/bin/env node
const { spawn } = process.getBuiltinModule("node:child_process");
const { mkdirSync, renameSync, writeFileSync } = process.getBuiltinModule("node:fs");
const { join } = process.getBuiltinModule("node:path");
const [cmd, ...args] = process.argv.slice(2);
if (!cmd) {
  process.stderr.write("usage: setsid program [arguments]\\n");
  process.exit(1);
}
// detached: the child calls setsid(), so its session and process group take its pid
const child = spawn(cmd, args, { detached: true, stdio: "inherit" });
child.on("error", (e) => {
  process.stderr.write("setsid: failed to execute " + cmd + ": " + e.message + "\\n");
  process.exit(1);
});
child.on("spawn", () => {
  const dir = process.env.${INSTANCE_ENV};
  if (dir) {
    mkdirSync(join(dir, "sessions"), { recursive: true });
    // through a rename: a reader never sees an empty record
    const record = join(dir, "sessions", String(process.pid));
    writeFileSync(record + ".tmp", String(child.pid));
    renameSync(record + ".tmp", record);
  }
  child.unref();
  process.exit(0);
});
`,
  timeout: `#!/usr/bin/env node
const { spawn, execFileSync } = process.getBuiltinModule("node:child_process");
const { constants } = process.getBuiltinModule("node:os");
let argv = process.argv.slice(2);
let signal = "SIGTERM";
for (;;) {
  if (argv[0] === "-s") {
    signal = argv[1] ?? "";
    argv = argv.slice(2);
  } else if (argv[0]?.startsWith("--signal=")) {
    signal = argv[0].slice(9);
    argv = argv.slice(1);
  } else break;
}
if (/^[0-9]+$/.test(signal)) {
  signal = Object.keys(constants.signals).find((k) => constants.signals[k] === Number(signal)) ?? "";
} else if (!signal.startsWith("SIG")) signal = "SIG" + signal;
const m = /^([0-9]*\\.?[0-9]+)([smhd]?)$/.exec(argv[0] ?? "");
if (!(signal in constants.signals) || !m || argv.length < 2) {
  process.stderr.write("usage: timeout [-s SIGNAL] DURATION COMMAND [ARG]...\\n");
  process.exit(125);
}
const ms = Number(m[1]) * { "": 1, s: 1, m: 60, h: 3600, d: 86400 }[m[2]] * 1000;
// Like GNU timeout (without --foreground), a termination signal it receives goes on to its command
// and to its whole process group. Without this, a pkill whose process list was read before the
// command (or a process the command started) existed killed only what it had listed and left the
// rest running in the session until the stop's grace period ran out. Installed before the spawn:
// a signal that arrives first ends the shim before it starts anything.
let child;
let passedOn = false;
for (const s of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(s, () => {
    if (child === undefined) process.exit(128 + constants.signals[s]);
    // the group signal reaches this shim too: pass it on once
    if (passedOn) return;
    passedOn = true;
    try {
      child.kill(s);
    } catch {}
    try {
      process.kill(0, s);
    } catch {}
  });
}
// not detached: the command stays in this process group, so in the caller's session
child = spawn(argv[1], argv.slice(2), { stdio: "inherit" });
let timedOut = false;
child.on("error", (e) => {
  process.stderr.write("timeout: failed to run command " + argv[1] + ": " + e.message + "\\n");
  process.exit(e.code === "ENOENT" ? 127 : 126);
});
/** The command and every process below it. */
function tree(root) {
  const ps = execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" });
  const kids = new Map();
  for (const line of ps.split("\\n")) {
    const [pid, ppid] = line.trim().split(/\\s+/).map(Number);
    if (!pid) continue;
    if (!kids.has(ppid)) kids.set(ppid, []);
    kids.get(ppid).push(pid);
  }
  const out = [root];
  for (let i = 0; i < out.length; i++) out.push(...(kids.get(out[i]) ?? []));
  return out;
}
const timer = ms > 0 ? setTimeout(() => {
  timedOut = true;
  for (const pid of tree(child.pid).reverse()) {
    try {
      process.kill(pid, signal);
    } catch {}
  }
  // GNU timeout signals its own group too: with KILL it dies itself, so the caller sees 137
  if (signal === "SIGKILL") process.exit(128 + constants.signals.SIGKILL);
}, ms) : undefined;
child.on("exit", (code, sig) => {
  if (timer) clearTimeout(timer);
  if (timedOut) process.exit(124);
  process.exit(code ?? 128 + (constants.signals[sig] ?? 0));
});
`,
  pgrep: `#!/usr/bin/env node
${SESSION_LOOKUP}
const argv = process.argv.slice(2);
if (argv.length !== 2 || argv[0] !== "-s") usage("pgrep");
const pids = sessionPids(argv[1]);
if (pids.length > 0) process.stdout.write(pids.join("\\n") + "\\n");
process.exit(pids.length > 0 ? 0 : 1);
`,
  pkill: `#!/usr/bin/env node
${SESSION_LOOKUP}
const { constants } = process.getBuiltinModule("node:os");
let argv = process.argv.slice(2);
let signal = "SIGTERM";
if (argv[0] && /^-[A-Z0-9]+$/.test(argv[0])) {
  const s = argv[0].slice(1);
  signal = /^[0-9]+$/.test(s)
    ? Object.keys(constants.signals).find((k) => constants.signals[k] === Number(s)) ?? ""
    : s.startsWith("SIG") ? s : "SIG" + s;
  argv = argv.slice(1);
}
if (!(signal in constants.signals) || argv.length !== 2 || argv[0] !== "-s") usage("pkill");
let n = 0;
for (const pid of sessionPids(argv[1])) {
  try {
    process.kill(pid, signal);
    n++;
  } catch {}
}
process.exit(n > 0 ? 0 : 1);
`,
};

/**
 * Writes the shims into `dir` (each through a rename, so a replica sharing the root never runs a
 * half-written one).
 */
function writeShims(dir: string): void {
  mkdirSync(dir, { recursive: true });
  for (const [name, source] of Object.entries(SHIMS)) {
    const tmp = join(dir, `.${name}.${process.pid}.${randomUUID().slice(0, 8)}`);
    writeFileSync(tmp, source, { mode: 0o755 });
    renameSync(tmp, join(dir, name));
  }
}

/** 读 `ops.log`：每行拆成 `[op, id, ...rest]`。 */
export async function readFakeSandboxOps(root: string): Promise<string[][]> {
  const text = await readFile(join(root, "ops.log"), "utf8").catch(() => "");
  return text
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => l.split(" "));
}

/** 设置慢操作延迟。 */
export async function setFakeSandboxDelays(root: string, d: FakeSandboxDelays): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "delays.json"), JSON.stringify(d));
}

/**
 * While `on`, a new file system gets the id `fs-<name>` (as sandbox-docker's volumes), so one made
 * again after a reset has the id of the destroyed one; off: random ids (the default).
 */
export async function setFakeFileSystemIdsByName(root: string, on: boolean): Promise<void> {
  await mkdir(root, { recursive: true });
  const flag = join(root, "fs-ids-by-name");
  if (on) await writeFile(flag, "");
  else await rm(flag, { force: true });
}

/**
 * A network failure every provider method throws while set: `code` as node's `net` sets it
 * (`ECONNREFUSED`, `ECONNRESET`, ...); `wrap: "fetch"` wraps it as `fetch` does
 * (`TypeError: fetch failed` with the socket error as `cause`).
 */
export interface FakeSandboxFault {
  code: string;
  syscall?: string;
  wrap?: "fetch";
}

/** Sets the network failure every provider method throws; `null` clears it. */
export async function setFakeSandboxFault(
  root: string,
  fault: FakeSandboxFault | null,
): Promise<void> {
  await mkdir(root, { recursive: true });
  if (fault === null) await rm(join(root, "fault.json"), { force: true });
  else await writeFile(join(root, "fault.json"), JSON.stringify(fault));
}

/** Makes the fake refuse the open public network, as a provider set to `refuseOpenNetwork: true` does (or stop). */
export async function setFakeSandboxRefuseOpenEgress(root: string, on: boolean): Promise<void> {
  await mkdir(root, { recursive: true });
  if (on) await writeFile(join(root, "refuse-open-egress"), "");
  else await rm(join(root, "refuse-open-egress"), { force: true });
}

/** The error of a fault, shaped like node's socket errors. */
function faultError(f: FakeSandboxFault): Error {
  const syscall = f.syscall ?? (f.code === "ECONNRESET" ? "read" : "connect");
  const socket = Object.assign(
    new Error(syscall === "connect" ? `connect ${f.code} 127.0.0.1:2375` : `${syscall} ${f.code}`),
    { code: f.code, syscall, address: "127.0.0.1", port: 2375 },
  );
  return f.wrap === "fetch" ? new TypeError("fetch failed", { cause: socket }) : socket;
}

/** `provider` whose every method first throws the fault set in `root/fault.json`, if any. */
function withFaults(root: string, provider: SandboxProvider): SandboxProvider {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(provider)) {
    out[key] =
      typeof value === "function"
        ? async (...args: unknown[]) => {
            const raw = await readFile(join(root, "fault.json"), "utf8").catch(() => null);
            if (raw !== null) throw faultError(JSON.parse(raw) as FakeSandboxFault);
            return (value as (...a: unknown[]) => unknown).apply(provider, args);
          }
        : value;
  }
  return out as unknown as SandboxProvider;
}

/**
 * The tags of the instance's exec commands that have started and not ended (`""` for an untagged
 * one): once a tag is listed, `killTagged` / `killAll` / `suspend` reach its command.
 */
export async function fakeSandboxRunningTags(root: string, id: string): Promise<string[]> {
  const dir = join(instanceDir(root, id), "procs");
  const pids = await readdir(dir).catch(() => [] as string[]);
  const tags = await Promise.all(
    pids.map((pid) => readFile(join(dir, pid), "utf8").catch(() => null)),
  );
  return tags.filter((t): t is string => t !== null);
}

/** 模拟提供方那边的实例被删（之后 resume 返回 `gone`）。 */
export async function removeFakeSandbox(root: string, id: string): Promise<void> {
  await rm(instanceDir(root, id), { recursive: true, force: true });
}

/** 实例的状态；不存在为 null。 */
export async function fakeSandboxState(
  root: string,
  id: string,
): Promise<"running" | "suspended" | null> {
  const s = await readFile(join(instanceDir(root, id), "state"), "utf8").catch(() => null);
  return s === "running" || s === "suspended" ? s : null;
}

/** 实例 create 时收到的参数；不存在为 null。 */
export async function fakeSandboxMeta(root: string, id: string): Promise<FakeSandboxMeta | null> {
  const s = await readFile(join(instanceDir(root, id), "meta.json"), "utf8").catch(() => null);
  return s === null ? null : (JSON.parse(s) as FakeSandboxMeta);
}

const ROOT_RE = /(^|[\s'"=:(<>|;&])(\/workspace|\/skills|\/tmp)(?=$|[/\s'"):;<>|&])/g;

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("aborted");
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  if (signal.aborted) throw abortError(signal);
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** 新建一个以 `root` 为「提供方后端」的假沙箱。 */
export function createFakeSandbox(
  rootDir: string,
  options: FakeSandboxOptions = {},
): SandboxProvider {
  // 用真实路径（macOS 的临时目录经符号链接），pwd 等输出才能换回沙箱路径
  mkdirSync(rootDir, { recursive: true });
  const root = realpathSync(rootDir);
  const binDir = join(root, "bin");
  /** Throws the open-network refusal when the fake is set to refuse it (see the file header). */
  const refuseOpen = async (limits: SandboxLimits) => {
    if (limits.network.kind !== "open-public") return;
    if (
      await stat(join(root, "refuse-open-egress")).then(
        () => true,
        () => false,
      )
    ) {
      throw new Error(
        `Sandbox open public network is refused: the sandbox-fake setting refuseOpenNetwork is true (token ${FAKE_REFUSAL_SECRET})`,
      );
    }
  };
  writeShims(binDir);
  const log = (line: string) => appendFile(join(root, "ops.log"), `${line}\n`);
  const logLimits = (e: FakeSandboxLimitsEntry) =>
    appendFile(join(root, "limits.log"), `${JSON.stringify(e)}\n`);
  const delay = async (op: keyof FakeSandboxDelays, signal: AbortSignal) => {
    const raw = await readFile(join(root, "delays.json"), "utf8").catch(() => "{}");
    await sleep((JSON.parse(raw) as FakeSandboxDelays)[op] ?? 0, signal);
  };
  /** Where `/workspace`, `/skills` and `/tmp` of the instance live on the host. */
  const mounts = async (h: SandboxHandle): Promise<Record<string, string>> => {
    const meta = await fakeSandboxMeta(root, h.id);
    if (meta === null) throw new SandboxGoneError(`fake sandbox ${h.id} is gone`);
    const fs = fileSystemDir(root, meta.fileSystem);
    return {
      "/workspace": join(fs, "workspace"),
      "/skills": join(fs, "skills"),
      "/tmp": join(instanceDir(root, h.id), "tmp"),
    };
  };
  const fsIdByName = async (name: string): Promise<string | null> => {
    for (const id of await fakeFileSystems(root)) {
      const raw = await readFile(join(fileSystemDir(root, id), "meta.json"), "utf8").catch(
        () => "",
      );
      if (raw !== "" && (JSON.parse(raw) as { name: string }).name === name) return id;
    }
    return null;
  };
  const requireRunning = async (h: SandboxHandle) => {
    const s = await fakeSandboxState(root, h.id);
    if (s === null) throw new SandboxGoneError(`fake sandbox ${h.id} is gone`);
    if (s !== "running") {
      // 契约：实例还在、只是停了 → 透明地启动
      await writeFile(join(instanceDir(root, h.id), "state"), "running");
      await log(`autostart ${h.id}`);
    }
  };
  const procsDir = (h: SandboxHandle) => join(instanceDir(root, h.id), "procs");
  const sessionsDir = (h: SandboxHandle) => join(instanceDir(root, h.id), "sessions");
  /**
   * This instance's setsid shims that are still starting: `echo $!` returned and the exec that
   * started one may have ended, but the shim has not spawned its command nor written its session
   * record yet (node starts slowly under load). Found as a process running the shim in one of the
   * instance's exec groups (`groups/<pgid>`).
   */
  const startingShims = async (h: SandboxHandle): Promise<number[]> => {
    const groups = new Set(
      await readdir(join(instanceDir(root, h.id), "groups")).catch(() => [] as string[]),
    );
    if (groups.size === 0) return [];
    const { stdout } = await promisify(execFile)("ps", ["-A", "-o", "pid=,pgid=,command="]);
    const shim = join(binDir, "setsid");
    const out: number[] = [];
    for (const line of stdout.split("\n")) {
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (m && groups.has(m[2] as string) && (m[3] as string).includes(shim))
        out.push(Number(m[1]));
    }
    return out;
  };
  /**
   * Kills every process the instance started: exec commands and shim sessions (by group). A shim
   * still starting is waited for first (up to 10 s), so the session it is about to start is killed
   * too instead of outliving the instance.
   */
  const killEverything = async (h: SandboxHandle) => {
    const until = Date.now() + 10_000;
    while (Date.now() < until && (await startingShims(h)).length > 0) {
      await sleep(20, new AbortController().signal);
    }
    const groups = await readdir(procsDir(h)).catch(() => [] as string[]);
    for (const sid of await readdir(sessionsDir(h)).catch(() => [] as string[])) {
      const pgid = await readFile(join(sessionsDir(h), sid), "utf8").catch(() => "");
      if (pgid !== "") groups.push(pgid);
    }
    for (const g of groups) {
      try {
        process.kill(-Number(g), "SIGKILL");
      } catch {
        // already exited
      }
    }
    await killExecutions(instanceDir(root, h.id));
  };
  /**
   * The host path of a device path. `/workspace`, `/skills` and `/tmp` map to the instance's
   * directories. Any other clean absolute path maps under the instance's `machine` directory (the
   * instance's whole file system) only where something bounds it: inside a permission-scoped
   * operation (the scope was checked first), or on an instance-boundary report (a cloud device:
   * the whole instance is in scope). A raw provider call outside the roots on an
   * operation-boundary instance throws, so kernel tests catch the kernel issuing a raw read or
   * write there instead of going through an operation.
   */
  const real = async (h: SandboxHandle, p: string) => {
    const errors = validateSandboxPathShape(p);
    if (errors.length > 0) throw new Error(errors.join("; "));
    const m = await mounts(h);
    const r = Object.keys(m).find((k) => p === k || p.startsWith(`${k}/`));
    if (r !== undefined) return join(m[r] as string, p.slice(r.length));
    if (scopedCall.getStore() !== true && (await fakeBoundary(root)) === "operation")
      throw new Error(
        `Sandbox path ${p} is outside the instance roots (/workspace, /skills, /tmp): a raw call ` +
          "outside them is refused on an operation-boundary device; use an operation",
      );
    return join(instanceDir(root, h.id), "machine", p.slice(1));
  };

  const provider: SandboxProvider = {
    concurrentExec: true as const,
    ...(options.limitsApplyAt !== undefined && { limitsApplyAt: options.limitsApplyAt }),

    async createFileSystem({ name, limits, signal }): Promise<FileSystemHandle> {
      await delay("create", signal);
      if (options.limitsApplyAt === "fileSystem") await refuseOpen(limits);
      const existing = await fsIdByName(name);
      if (existing !== null) return { id: existing };
      const byName = await stat(join(root, "fs-ids-by-name")).then(
        () => true,
        () => false,
      );
      const id = byName ? `fs-${name}` : `fs-${randomUUID().slice(0, 8)}`;
      const dir = fileSystemDir(root, id);
      for (const r of ["workspace", "skills"]) await mkdir(join(dir, r), { recursive: true });
      await writeFile(join(dir, "meta.json"), JSON.stringify({ name, limits }));
      await logLimits({ op: "create-fs", id, limits });
      await log(`create-fs ${id} ${name}`);
      return { id };
    },

    async destroyFileSystem(fs, signal) {
      await delay("destroy", signal);
      await rm(fileSystemDir(root, fs.id), { recursive: true, force: true });
      await log(`destroy-fs ${fs.id}`);
    },

    async destroyFileSystemByName(name, signal) {
      await delay("destroy", signal);
      const id = await fsIdByName(name);
      if (id !== null) await rm(fileSystemDir(root, id), { recursive: true, force: true });
      await log(`destroy-fs-by-name ${name}`);
    },

    async create({ name, image, limits, fileSystem, signal }) {
      await delay("create", signal);
      await refuseOpen(limits);
      if (!(await stat(fileSystemDir(root, fileSystem.id)).catch(() => null))) {
        throw new FileSystemGoneError(`fake file system ${fileSystem.id} is gone`);
      }
      const id = `fake-${randomUUID().slice(0, 8)}`;
      const dir = instanceDir(root, id);
      await mkdir(join(dir, "tmp"), { recursive: true });
      const meta: FakeSandboxMeta = {
        name,
        image: image ?? null,
        fileSystem: fileSystem.id,
        limits,
      };
      await writeFile(join(dir, "meta.json"), JSON.stringify(meta));
      await writeFile(join(dir, "state"), "running");
      await logLimits({ op: "create", id, limits });
      await log(`create ${id} ${name}`);
      return { id };
    },

    async resume(h, signal) {
      await delay("resume", signal);
      if ((await fakeSandboxState(root, h.id)) === null) {
        await log(`resume-gone ${h.id}`);
        return "gone";
      }
      await writeFile(join(instanceDir(root, h.id), "state"), "running");
      await log(`resume ${h.id}`);
      return "resumed";
    },

    async suspend(h, signal) {
      await delay("suspend", signal);
      // 实例已不在：当作已停止（下一次 resume 会返回 gone）
      if ((await fakeSandboxState(root, h.id)) !== null) {
        await killEverything(h);
        await writeFile(join(instanceDir(root, h.id), "state"), "suspended");
      }
      await log(`suspend ${h.id}`);
    },

    async destroy(h, signal) {
      await delay("destroy", signal);
      await killEverything(h);
      await rm(instanceDir(root, h.id), { recursive: true, force: true });
      await log(`destroy ${h.id}`);
    },

    async destroyByName(name, signal) {
      await delay("destroy", signal);
      const ids = await readdir(join(root, "instances")).catch(() => [] as string[]);
      for (const id of ids) {
        if ((await fakeSandboxMeta(root, id))?.name === name) {
          await killEverything({ id });
          await rm(instanceDir(root, id), { recursive: true, force: true });
        }
      }
      await log(`destroy-by-name ${name}`);
    },

    async exec(h, args): Promise<ExecResult> {
      args.signal.throwIfAborted();
      if (args.tag !== undefined && !SANDBOX_TAG_RE.test(args.tag)) {
        throw new Error("invalid sandbox tag");
      }
      await requireRunning(h);
      const startedAt = Date.now();
      await delay("exec", args.signal);
      const m = await mounts(h);
      const command = args.command.replace(
        ROOT_RE,
        (_m, pre: string, r: string) => `${pre}${m[r] as string}`,
      );
      const cwd = await real(h, args.cwd ?? "/workspace");
      const back = (s: string) => {
        let out = s;
        for (const [r, dir] of Object.entries(m)) out = out.split(dir).join(r);
        return out;
      };
      return new Promise<ExecResult>((resolve) => {
        const child = spawn("/bin/sh", ["-c", command], {
          cwd,
          env: {
            HOME: m["/workspace"],
            ...args.env,
            PATH: `${binDir}:${args.env?.PATH ?? process.env.PATH ?? "/usr/bin:/bin"}`,
            [INSTANCE_ENV]: instanceDir(root, h.id),
          },
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let out: Buffer = Buffer.alloc(0);
        let err: Buffer = Buffer.alloc(0);
        let truncated = false;
        let timedOut = false;
        let killed = false;
        const take = (buf: Buffer, chunk: Buffer): Buffer => {
          const room = args.maxOutputBytes - out.byteLength - err.byteLength;
          if (chunk.byteLength > room) truncated = true;
          return room > 0 ? Buffer.concat([buf, chunk.subarray(0, room)]) : buf;
        };
        child.stdout.on("data", (c: Buffer) => {
          out = take(out, c);
        });
        child.stderr.on("data", (c: Buffer) => {
          err = take(err, c);
        });
        const kill = () => {
          killed = true;
          try {
            if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
          } catch {
            // 已退出
          }
        };
        const pidFile = child.pid === undefined ? undefined : join(procsDir(h), String(child.pid));
        if (pidFile) {
          mkdirSync(dirname(pidFile), { recursive: true });
          writeFileSync(pidFile, args.tag ?? "");
          // kept after the command ends: a setsid shim it started in the background may still be
          // starting in this group when pgrep / pkill ask for its session
          const group = join(instanceDir(root, h.id), "groups", String(child.pid));
          mkdirSync(dirname(group), { recursive: true });
          writeFileSync(group, "");
        }
        const timer = setTimeout(() => {
          timedOut = true;
          kill();
        }, args.timeoutMs);
        const onAbort = () => kill();
        args.signal.addEventListener("abort", onAbort, { once: true });
        // spawn 与登记监听之间已被中止：监听不会再触发，这里立即杀掉
        if (args.signal.aborted) kill();
        child.once("close", (code) => {
          clearTimeout(timer);
          if (pidFile) rmSync(pidFile, { force: true });
          args.signal.removeEventListener("abort", onAbort);
          const result = {
            exitCode: killed ? null : code,
            stdout: back(out.toString("utf8")),
            stderr: back(err.toString("utf8")),
            truncated,
            timedOut,
          };
          const who = `${args.actor?.accountId ?? "-"} ${args.actor?.conversationId ?? "-"}`;
          void log(`exec ${h.id} ${args.tag ?? "-"} ${startedAt} ${Date.now()} ${who}`)
            .catch(() => {})
            .finally(() => resolve(result));
        });
      });
    },

    async killAll(h, signal) {
      signal.throwIfAborted();
      await requireRunning(h);
      const pids = await readdir(procsDir(h)).catch(() => [] as string[]);
      for (const pid of pids) {
        try {
          process.kill(-Number(pid), "SIGKILL");
        } catch {
          // 已退出
        }
      }
      await log(`kill-all ${h.id}`);
    },

    async killTagged(h, tags, signal) {
      signal.throwIfAborted();
      for (const t of tags) if (!SANDBOX_TAG_RE.test(t)) throw new Error("invalid sandbox tag");
      await requireRunning(h);
      const want = new Set(tags);
      const pids = await readdir(procsDir(h)).catch(() => [] as string[]);
      for (const pid of pids) {
        const tag = await readFile(join(procsDir(h), pid), "utf8").catch(() => "");
        if (!want.has(tag)) continue;
        try {
          process.kill(-Number(pid), "SIGKILL");
        } catch {
          // already exited
        }
      }
      await log(`kill-tagged ${h.id} ${tags.join(",")}`);
    },

    async readFile(h, path, opts) {
      opts.signal.throwIfAborted();
      await requireRunning(h);
      const p = await real(h, path);
      const data = await readFile(p).catch(() => null);
      if (data === null) return null;
      const truncated = data.byteLength > opts.maxBytes;
      return {
        data: new Uint8Array(truncated ? data.subarray(0, opts.maxBytes) : data),
        truncated,
      };
    },

    async writeFile(h, path, data, signal) {
      signal.throwIfAborted();
      await requireRunning(h);
      const p = await real(h, path);
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, data);
    },

    async stat(h, path, signal) {
      signal.throwIfAborted();
      await requireRunning(h);
      const s = await stat(await real(h, path)).catch(() => null);
      return s === null ? null : { size: s.size, isDir: s.isDirectory() };
    },
  };
  if (options.list === true) {
    provider.list = async (h, path, opts) => {
      opts.signal.throwIfAborted();
      await requireRunning(h);
      const p = await real(h, path);
      const s = await stat(p).catch(() => null);
      if (s === null) return null;
      if (!s.isDirectory()) throw new Error(`not a directory: ${path}`);
      const dirents = await readdir(p, { withFileTypes: true });
      const entries = await Promise.all(
        dirents.map(async (d) => ({
          name: d.name,
          // stat semantics: a link to a directory is a directory
          isDir: await stat(join(p, d.name)).then(
            (t) => t.isDirectory(),
            () => false,
          ),
        })),
      );
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      return { entries: entries.slice(0, opts.limit), truncated: entries.length > opts.limit };
    };
    // offering projects takes both; the fake suggests none
    provider.scan = async (h, _base, opts) => {
      opts.signal.throwIfAborted();
      await requireRunning(h);
      return [];
    };
  }
  const mode = options.updateMode ?? "none";
  if (mode !== "none") {
    provider.update = async (h, limits, signal) => {
      await delay("update", signal);
      const meta = await fakeSandboxMeta(root, h.id);
      if (meta === null) throw new SandboxGoneError(`fake sandbox ${h.id} is gone`);
      await logLimits({ op: "update", id: h.id, limits });
      await log(`update ${h.id} ${mode}`);
      await refuseOpen(limits);
      if (mode === "throw") throw new Error("fake update failed");
      if (mode === "updated") {
        await writeFile(
          join(instanceDir(root, h.id), "meta.json"),
          JSON.stringify({ ...meta, limits }),
        );
      }
      return mode;
    };
  }
  Object.assign(
    provider,
    managedSurface(provider, {
      root,
      binDir,
      list: options.list === true,
      real,
      mounts,
      requireRunning,
      log,
    }),
  );
  return withFaults(root, provider);
}

/** 测试用 `sandbox@2`：部署配置 `{ root }`，见文件头注释。 */
export default defineExtension({
  name: "sandbox-fake",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: [SANDBOX_EXTENSION_POINT],
  // 只用部署配置与本地文件，不用任何需要声明的平台能力
  permissions: {},
  config: { deployment: Deployment },
  setup(ctx) {
    const { root, updateMode, limitsApplyAt, list } = ctx.config as z.infer<typeof Deployment>;
    ctx.provide(
      SANDBOX_EXTENSION_POINT,
      createFakeSandbox(root, {
        ...(updateMode !== undefined && { updateMode }),
        ...(limitsApplyAt !== undefined && { limitsApplyAt }),
        ...(list !== undefined && { list }),
      }),
    );
  },
});

/** What the managed surface needs from the raw fake (see {@link createFakeSandbox}). */
interface FakeInternals {
  root: string;
  binDir: string;
  list: boolean;
  /**
   * The host path of a device path (throws on a bad shape or, for a raw call on an
   * operation-boundary instance, outside the roots).
   */
  real(h: SandboxHandle, p: string): Promise<string>;
  /** Where `/workspace`, `/skills` and `/tmp` of the instance live on the host. */
  mounts(h: SandboxHandle): Promise<Record<string, string>>;
  /** Starts a suspended instance (the contract's auto-start); throws when it is gone. */
  requireRunning(h: SandboxHandle): Promise<void>;
  log(line: string): Promise<void>;
}

/**
 * Marks the raw calls a permission-scoped operation makes after its scope check: they may reach
 * the instance's whole file system (see `real` in {@link createFakeSandbox}).
 */
const scopedCall = new AsyncLocalStorage<true>();

/** The boundary the fake reports now (its override file, else {@link FAKE_PERMISSION_SUPPORT}). */
async function fakeBoundary(root: string): Promise<"operation" | "instance"> {
  const text = await readFile(join(root, "permission-support.json"), "utf8").catch(() => null);
  return text === null
    ? FAKE_PERMISSION_SUPPORT.boundary
    : (JSON.parse(text) as SandboxPermissionSupport).boundary;
}

/** The fake's default permission support: both profiles and background ownership. */
export const FAKE_PERMISSION_SUPPORT: SandboxPermissionSupport = Object.freeze({
  version: 2,
  restricted: Object.freeze({
    filesystem: true,
    network: true,
    native: true,
    concurrentScopes: true,
  }),
  boundary: "operation",
  network: { openPublic: false, allowlist: true, perOperationHosts: true },
  outsideSandbox: true,
  background: true,
}) as SandboxPermissionSupport;

/**
 * The report of an instance-boundary provider (a cloud device: the container or microVM is the
 * sandbox), for {@link setFakeSandboxPermissionSupport}: no per-operation restriction, the whole
 * instance in scope (raw calls anywhere in it included), the provider's outer network open or an
 * allowlist with no per-call hosts, and nothing outside the sandbox.
 */
export const FAKE_INSTANCE_PERMISSION_SUPPORT: SandboxPermissionSupport = Object.freeze({
  version: 2,
  boundary: "instance",
  restricted: null,
  network: { openPublic: true, allowlist: true, perOperationHosts: false },
  outsideSandbox: false,
  background: true,
}) as SandboxPermissionSupport;

/**
 * Overrides what `permissionSupport` answers (read at each call); `null` restores
 * {@link FAKE_PERMISSION_SUPPORT}. The boundary it reports also decides where raw calls reach.
 */
export async function setFakeSandboxPermissionSupport(
  root: string,
  report: SandboxPermissionSupport | null,
): Promise<void> {
  await mkdir(root, { recursive: true });
  const file = join(root, "permission-support.json");
  if (report === null) await rm(file, { force: true });
  else await writeFile(file, JSON.stringify(report));
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const within = (p: string, root: string) =>
  p === root || p.startsWith(root.endsWith("/") ? root : `${root}/`);
const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

/** JSON with byte arrays kept (an operation's recorded result). */
const encode = (value: unknown) =>
  JSON.stringify({ value }, (_key, v) =>
    v instanceof Uint8Array ? { $bytes: Buffer.from(v).toString("base64") } : v,
  );
const decode = (text: string) =>
  (
    JSON.parse(text, (_key, v) =>
      v && typeof v === "object" && "$bytes" in v
        ? new Uint8Array(Buffer.from(v.$bytes, "base64"))
        : v,
    ) as { value: unknown }
  ).value;

/** One background execution as the fake records it (`instances/<id>/executions/<hash>/ref.json`). */
interface FakeExecutionRecord {
  ref: SandboxExecutionRef;
  inputHash: string;
  /** The host path of the task's output file. */
  output: string;
  retainUntilMs: number;
}

/** Final lines a terminal tail keeps (as the device's supervisor does). */
const TAIL_LINES = 20;
const MAX_READ = 65_536;

/**
 * The permission-scoped operation surface of `sandbox@2` (permission operation contract) over the
 * raw fake. Every check below is real so tests stay meaningful; what the fake cannot do is isolate
 * a command: a restricted `exec` runs on the host like any other, and only its working directory
 * and the instance roots its text names are checked against the scope (no network filter).
 *
 * - `operation`: each method consumes its operation id before any effect (`operation-records/`);
 *   a matching retry returns the recorded result, a retry after an effect without a recorded
 *   result throws `SandboxOperationOutcomeUnknownError`, another input under the same id is
 *   denied. Scoped file access is checked against the read roots (writable roots are readable)
 *   and the write roots; `device` scope reaches what the raw provider reaches.
 * - `prepare`: reads and writes inside the preparation's write roots only, no exec.
 * - `browse` (with `list`): stat, list and scan inside the read roots only.
 * - `revokeOperation`: a tombstone (`operation-revoked/`) checked before every launch, then kills
 *   the operation's exec commands and its background execution (never auto-starts).
 * - `background`: `start` launches the command in its own process group (through the `timeout`
 *   shim) with merged output appended to the task's output file and the exit code written to the
 *   execution record; idempotent per operation id. `status` / `tail` / `readOutput` / `stop` take
 *   the exact reference and never start or resume the instance. Suspending or destroying the
 *   instance kills its executions, which are then `lost` with their output unavailable.
 */
function managedSurface(
  raw: SandboxProvider,
  f: FakeInternals,
): Pick<
  SandboxProvider,
  "permissionSupport" | "operation" | "prepare" | "browse" | "revokeOperation" | "background"
> {
  const instanceDir = (h: SandboxHandle) => join(f.root, "instances", h.id);
  const executionDir = (h: SandboxHandle, operationId: string) =>
    join(instanceDir(h), "executions", sha256(operationId));
  const revoked = (operationId: string) =>
    exists(join(f.root, "operation-revoked", sha256(operationId)));
  const deny = (what: string): never => {
    throw new SandboxScopeDeniedError(`${what} is outside this operation's permitted scope`);
  };

  /** Consumes `operationId` for `input`, then runs `work` once (see the surface's doc). */
  const consume = async <T>(
    operationId: string,
    input: unknown,
    work: () => Promise<T>,
  ): Promise<T> => {
    const dir = join(f.root, "operation-records", sha256(operationId));
    await mkdir(dirname(dir), { recursive: true });
    const hash = sha256(encode(input));
    try {
      await mkdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const prior = await readFile(join(dir, "request"), "utf8").catch(() => "");
      if (prior !== hash) throw new SandboxScopeDeniedError("Operation identity was reused");
      const result = await readFile(join(dir, "result"), "utf8").catch(() => null);
      if (result === null)
        throw new SandboxOperationOutcomeUnknownError("The fake operation outcome is unknown");
      return decode(result) as T;
    }
    await writeFile(join(dir, "request"), hash);
    if (await revoked(operationId)) throw new SandboxScopeDeniedError("Operation revoked");
    const value = await scopedCall.run(true, work);
    await writeFile(join(dir, "result"), encode(value));
    return value;
  };

  const readable = (scope: SandboxFileScope, path: string) => {
    if (validateSandboxPathShape(path).length > 0) deny(`The path ${path}`);
    if (scope.kind === "device") return;
    if (![...scope.readRoots, ...scope.writeRoots].some((r) => within(path, r)))
      deny(`Reading ${path}`);
  };
  const writable = (scope: SandboxFileScope, path: string) => {
    if (validateSandboxPathShape(path).length > 0) deny(`The path ${path}`);
    if (scope.kind === "device") return;
    if (!scope.writeRoots.some((r) => within(path, r))) deny(`Writing ${path}`);
  };
  /** A command's working directory and the instance roots its text names (see the doc above). */
  const runnable = (scope: SandboxFileScope, command: string, cwd: string) => {
    readable(scope, cwd);
    if (scope.kind === "device") return;
    const roots = [...scope.readRoots, ...scope.writeRoots];
    for (const m of command.matchAll(ROOT_RE)) {
      const named = m[2] as string;
      if (!roots.some((r) => within(r, named) || within(named, r))) deny(`Running in ${named}`);
    }
  };

  const native = (
    h: SandboxHandle,
    fs: SandboxFileScope,
    signal: AbortSignal,
    once: <T>(input: unknown, work: () => Promise<T>) => Promise<T>,
  ) => ({
    readFile: async (path: string, opts: { maxBytes: number; signal: AbortSignal }) => {
      readable(fs, path);
      return once({ method: "readFile", path, maxBytes: opts.maxBytes }, () =>
        raw.readFile(h, path, { ...opts, signal: AbortSignal.any([signal, opts.signal]) }),
      );
    },
    writeFile: async (path: string, data: Uint8Array, sig: AbortSignal) => {
      writable(fs, path);
      return once({ method: "writeFile", path, data: new Uint8Array(data) }, () =>
        raw.writeFile(h, path, data, AbortSignal.any([signal, sig])),
      );
    },
    stat: async (path: string, sig: AbortSignal) => {
      readable(fs, path);
      return once({ method: "stat", path }, () =>
        raw.stat(h, path, AbortSignal.any([signal, sig])),
      );
    },
    ...(raw.list && raw.scan
      ? {
          list: async (path: string, opts: { limit: number; signal: AbortSignal }) => {
            readable(fs, path);
            return once({ method: "list", path, limit: opts.limit }, async () =>
              (raw.list as NonNullable<SandboxProvider["list"]>)(h, path, {
                ...opts,
                signal: AbortSignal.any([signal, opts.signal]),
              }),
            );
          },
          scan: async (base: string, opts: { signal: AbortSignal }) => {
            readable(fs, base);
            return once({ method: "scan", base }, async () =>
              (raw.scan as NonNullable<SandboxProvider["scan"]>)(h, base, {
                signal: AbortSignal.any([signal, opts.signal]),
              }),
            );
          },
        }
      : {}),
  });

  /** Kills every process of the group `pgid` with `sig`; false when none was left. */
  const signalGroup = (pgid: number, sig: NodeJS.Signals | 0): boolean => {
    try {
      process.kill(-pgid, sig);
      return true;
    } catch {
      return false;
    }
  };
  /** The record of `ref`, checked field by field; scope-denied on any mismatch. */
  const recordOf = async (h: SandboxHandle, given: SandboxExecutionRef) => {
    const ref = parseSandboxExecutionRef(given);
    if (ref.instanceId !== h.id) deny("This execution's instance");
    const dir = executionDir(h, ref.operationId);
    const text = await readFile(join(dir, "ref.json"), "utf8").catch(() => null);
    // the instance (and with it the record) is gone: nothing to validate against
    if (text === null) {
      if (!(await exists(instanceDir(h)))) return { dir, record: null };
      return deny("No execution with this exact reference");
    }
    const record = JSON.parse(text) as FakeExecutionRecord;
    if (
      record.ref.executionId !== ref.executionId ||
      record.ref.instanceGeneration !== ref.instanceGeneration
    )
      deny("No execution with this exact reference");
    return { dir, record };
  };
  const exitOf = async (dir: string) => {
    const text = await readFile(join(dir, "exit"), "utf8").catch(() => null);
    if (text === null) return null;
    const code = Number(text.trim());
    return { exitCode: Number.isInteger(code) ? code : null, timedOut: code === 124 };
  };
  const statusOf = async (
    dir: string,
    record: FakeExecutionRecord | null,
  ): Promise<SandboxExecutionStatus> => {
    if (record === null || (await exists(join(dir, "lost")))) return { state: "lost" };
    const exit = await exitOf(dir);
    if (exit) return { state: "exited", ...exit };
    const pgid = Number(await readFile(join(dir, "pgid"), "utf8").catch(() => "0"));
    if (pgid > 0 && signalGroup(pgid, 0)) return { state: "running" };
    // the exit record may have been written since it was read
    const late = await exitOf(dir);
    return late ? { state: "exited", ...late } : { state: "lost" };
  };
  /** The output a read may serve, or why none is. */
  const retained = async (
    dir: string,
    record: FakeExecutionRecord | null,
  ): Promise<{ unavailable: "lost" | "expired" } | { status: SandboxExecutionStatus }> => {
    if (record === null || (await exists(join(dir, "lost")))) return { unavailable: "lost" };
    if (record.retainUntilMs <= Date.now()) return { unavailable: "expired" };
    if (!(await exists(record.output))) return { unavailable: "lost" };
    return { status: await statusOf(dir, record) };
  };

  const background: SandboxBackground = {
    async start(h, given, args) {
      const scope = parseSandboxOperationScope(given);
      args.signal.throwIfAborted();
      const generation = args.instanceGeneration;
      if (generation === undefined || !/^[0-9]{1,16}$/.test(generation))
        throw new SandboxScopeDeniedError("The fake needs the kernel's instance generation");
      const cwd = args.cwd ?? "/workspace";
      runnable(scope.filesystem, args.command, cwd);
      writable(scope.filesystem, args.outputPath);
      const { signal: _signal, ...input } = args;
      const inputHash = sha256(JSON.stringify({ scope, input }));
      const dir = executionDir(h, scope.operationId);
      await mkdir(dirname(dir), { recursive: true });
      try {
        await mkdir(dir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const text = await readFile(join(dir, "ref.json"), "utf8").catch(() => null);
        if (text === null)
          throw new SandboxOperationOutcomeUnknownError("The fake start outcome is unknown");
        const record = JSON.parse(text) as FakeExecutionRecord;
        if (record.inputHash !== inputHash)
          throw new SandboxScopeDeniedError("Operation identity was reused");
        return record.ref;
      }
      if (await revoked(scope.operationId)) {
        await rm(dir, { recursive: true, force: true });
        throw new SandboxScopeDeniedError("Operation revoked");
      }
      await f.requireRunning(h);
      const m = await f.mounts(h);
      // after the scope check: the paths may lie anywhere the scope grants
      const output = await scopedCall.run(true, () => f.real(h, args.outputPath));
      await mkdir(dirname(output), { recursive: true });
      // the artifact exists once the start is acknowledged; the command writes through the
      // descriptor opened here, so a later removal of the file never brings it back
      const fd = openSync(output, "a");
      const command = args.command.replace(
        ROOT_RE,
        (_m, pre: string, r: string) => `${pre}${m[r] as string}`,
      );
      const seconds = Math.max(0.001, args.timeoutMs / 1000);
      // the wrapper owns the group: the command's exit code (124 after the timeout) is recorded
      // through a rename, so a reader never sees a half-written one; then what the command left
      // running in the group is killed, as a device ends what an exec left behind
      const script =
        'timeout -s TERM "$1" /bin/sh -c "$2" 2>&1 </dev/null; ' +
        'printf "%s" "$?" >"$3.tmp" && mv "$3.tmp" "$3"; kill -KILL 0';
      const child = spawn(
        "/bin/sh",
        ["-c", script, "sh", String(seconds), command, join(dir, "exit")],
        {
          cwd: await scopedCall.run(true, () => f.real(h, cwd)),
          env: {
            HOME: m["/workspace"],
            ...args.env,
            PATH: `${f.binDir}:${args.env?.PATH ?? process.env.PATH ?? "/usr/bin:/bin"}`,
            [INSTANCE_ENV]: instanceDir(h),
          },
          detached: true,
          stdio: ["ignore", fd, fd],
        },
      );
      closeSync(fd);
      if (child.pid === undefined) {
        await rm(dir, { recursive: true, force: true });
        throw new Error("the fake could not start the background command");
      }
      child.unref();
      await writeFile(join(dir, "pgid"), String(child.pid));
      const ref: SandboxExecutionRef = {
        executionId: `fx-${randomUUID().slice(0, 12)}`,
        operationId: scope.operationId,
        instanceId: h.id,
        instanceGeneration: generation,
      };
      const record: FakeExecutionRecord = {
        ref,
        inputHash,
        output,
        retainUntilMs: args.retainUntilMs,
      };
      await writeFile(join(dir, "ref.json.tmp"), JSON.stringify(record));
      await rename(join(dir, "ref.json.tmp"), join(dir, "ref.json"));
      await f.log(`bg-start ${h.id} ${scope.operationId} ${child.pid}`);
      return ref;
    },

    async status(h, ref, signal) {
      signal.throwIfAborted();
      const { dir, record } = await recordOf(h, ref);
      return statusOf(dir, record);
    },

    async tail(h, ref, opts) {
      opts.signal.throwIfAborted();
      if (!Number.isSafeInteger(opts.maxBytes) || opts.maxBytes < 0 || opts.maxBytes > MAX_READ)
        throw new SandboxScopeDeniedError("Tail budget must be between 0 and 65536 bytes");
      const { dir, record } = await recordOf(h, ref);
      const r = await retained(dir, record);
      if ("unavailable" in r) return r;
      const out = await readFile((record as FakeExecutionRecord).output);
      let bytes = out.subarray(Math.max(0, out.length - MAX_READ));
      let begin = 0;
      while (begin < bytes.length && ((bytes[begin] as number) & 0xc0) === 0x80) begin++;
      bytes = bytes.subarray(begin);
      let start = Math.max(0, bytes.length - opts.maxBytes);
      if (r.status.state === "exited") {
        let cursor = bytes.length - (bytes.at(-1) === 10 ? 1 : 0);
        for (let line = 0; line < TAIL_LINES; line++) {
          const previous = bytes.lastIndexOf(10, cursor - 1);
          if (previous < 0) {
            cursor = -1;
            break;
          }
          cursor = previous;
        }
        start = Math.max(start, cursor + 1);
      }
      while (start < bytes.length && ((bytes[start] as number) & 0xc0) === 0x80) start++;
      return {
        data: new Uint8Array(bytes.subarray(start)),
        truncated: out.length > bytes.length || start > 0,
      };
    },

    async readOutput(h, ref, opts) {
      opts.signal.throwIfAborted();
      if (!Number.isSafeInteger(opts.offset) || opts.offset < 0)
        throw new SandboxScopeDeniedError("The offset must be a nonnegative safe integer");
      if (!Number.isInteger(opts.maxBytes) || opts.maxBytes < 0 || opts.maxBytes > MAX_READ)
        throw new SandboxScopeDeniedError("maxBytes must be between 0 and 65536");
      const { dir, record } = await recordOf(h, ref);
      const r = await retained(dir, record);
      if ("unavailable" in r) return r;
      // one snapshot: the size pinned now, the bytes read below it
      const out = await readFile((record as FakeExecutionRecord).output);
      const totalBytes = out.length;
      const n = Math.max(0, Math.min(opts.maxBytes, totalBytes - opts.offset));
      const data = new Uint8Array(out.subarray(opts.offset, opts.offset + n));
      return { data, offset: opts.offset, nextOffset: opts.offset + n, totalBytes };
    },

    async stop(h, ref, opts) {
      opts.signal.throwIfAborted();
      if (!Number.isFinite(opts.graceMs) || opts.graceMs < 0 || opts.graceMs > 30_000)
        throw new SandboxScopeDeniedError("Invalid stop grace");
      const { dir, record } = await recordOf(h, ref);
      const claimed = await readFile(join(dir, "claim"), "utf8").catch(() => null);
      if (claimed !== null) return JSON.parse(claimed) as SandboxStopResult;
      const claim = async (outcome: SandboxStopResult): Promise<SandboxStopResult> => {
        try {
          // the first claim wins; a retry or a racing stop answers what it claimed
          await writeFile(join(dir, "claim"), JSON.stringify(outcome), { flag: "wx" });
          return outcome;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          return JSON.parse(await readFile(join(dir, "claim"), "utf8")) as SandboxStopResult;
        }
      };
      const now = await statusOf(dir, record);
      if (record === null) return { outcome: "lost" };
      if (now.state === "lost") return claim({ outcome: "lost" });
      if (now.state === "exited")
        return claim({ outcome: "already-exited", exitCode: now.exitCode, timedOut: now.timedOut });
      const pgid = Number(await readFile(join(dir, "pgid"), "utf8").catch(() => "0"));
      signalGroup(pgid, "SIGTERM");
      const until = Date.now() + opts.graceMs;
      while (Date.now() < until && signalGroup(pgid, 0)) {
        await sleep(20, opts.signal);
      }
      signalGroup(pgid, "SIGKILL");
      const outcome = await claim({ outcome: "stopped" });
      // a stopped execution exits as a terminated one, unless its own exit was recorded first
      if (!(await exists(join(dir, "exit")))) await writeFile(join(dir, "exit"), "143");
      await f.log(`bg-stop ${h.id} ${ref.operationId}`);
      return outcome;
    },
  };

  const support = async (): Promise<SandboxPermissionSupport> => {
    const text = await readFile(join(f.root, "permission-support.json"), "utf8").catch(() => null);
    return text === null ? FAKE_PERMISSION_SUPPORT : (JSON.parse(text) as SandboxPermissionSupport);
  };

  return {
    async permissionSupport(_h, signal) {
      signal.throwIfAborted();
      return support();
    },

    async operation(h, given, signal) {
      const scope = parseSandboxOperationScope(given);
      signal.throwIfAborted();
      // an instance boundary runs the whole instance, never a narrower scope (the cloud providers)
      if (
        scope.filesystem.kind === "scoped" &&
        (await support()).boundary === "instance" &&
        !(scope.filesystem.readRoots.includes("/") && scope.filesystem.writeRoots.includes("/"))
      )
        throw new SandboxPermissionUnsupportedError(
          "sandbox-fake's instance boundary runs only the instance scope: / readable and writable",
        );
      const once = <T>(input: unknown, work: () => Promise<T>) =>
        consume(scope.operationId, { scope, ...(input as object) }, work);
      await mkdir(join(f.root, "operation-tags"), { recursive: true });
      await writeFile(join(f.root, "operation-tags", sha256(scope.operationId)), scope.tag);
      return {
        ...native(h, scope.filesystem, signal, once),
        exec: async (args) => {
          runnable(scope.filesystem, args.command, args.cwd ?? "/workspace");
          const { signal: callSignal, ...input } = args;
          return once({ method: "exec", args: input }, () =>
            raw.exec(h, {
              ...args,
              actor: scope.actor,
              tag: scope.tag,
              signal: AbortSignal.any([signal, callSignal]),
            }),
          );
        },
      };
    },

    async prepare(h, given, signal) {
      const scope = parseSandboxPreparationScope(given);
      const fs: SandboxFileScope = {
        kind: "scoped",
        readRoots: scope.writeRoots,
        writeRoots: scope.writeRoots,
      };
      const { readFile, writeFile, stat } = native(h, fs, signal, (_input, work) =>
        scopedCall.run(true, work),
      );
      return { readFile, writeFile, stat };
    },

    ...(f.list && {
      async browse(h, given, signal) {
        const scope = parseSandboxBrowseScope(given);
        const fs: SandboxFileScope = { kind: "scoped", readRoots: scope.readRoots, writeRoots: [] };
        const n = native(h, fs, signal, (_input, work) => scopedCall.run(true, work));
        return {
          stat: n.stat,
          list: n.list as NonNullable<SandboxOperation["list"]>,
          scan: n.scan as NonNullable<SandboxOperation["scan"]>,
        };
      },
    }),

    async revokeOperation(h, ref, signal) {
      signal.throwIfAborted();
      const { operationId } = parseSandboxOperationRef(ref);
      await mkdir(join(f.root, "operation-revoked"), { recursive: true });
      await writeFile(join(f.root, "operation-revoked", sha256(operationId)), "");
      // the operation's exec commands, by its tag (never auto-starting the instance)
      const tag = await readFile(join(f.root, "operation-tags", sha256(operationId)), "utf8").catch(
        () => null,
      );
      const procs = join(instanceDir(h), "procs");
      for (const pid of await readdir(procs).catch(() => [] as string[])) {
        const t = await readFile(join(procs, pid), "utf8").catch(() => null);
        if (t !== null && (t === tag || t === operationId)) signalGroup(Number(pid), "SIGKILL");
      }
      // and its background execution
      const dir = executionDir(h, operationId);
      const pgid = Number(await readFile(join(dir, "pgid"), "utf8").catch(() => "0"));
      if (pgid > 0 && !(await exists(join(dir, "exit")))) {
        signalGroup(pgid, "SIGKILL");
        await writeFile(join(dir, "claim"), JSON.stringify({ outcome: "stopped" }), {
          flag: "wx",
        }).catch(() => {});
        if (!(await exists(join(dir, "exit")))) await writeFile(join(dir, "exit"), "143");
      }
      await f.log(`revoke ${h.id} ${operationId}`);
    },

    background,
  };
}

/**
 * Kills the instance's background executions (suspend, destroy): an execution that had not
 * exited is then `lost`, its output unavailable.
 */
async function killExecutions(instanceDir: string): Promise<void> {
  const base = join(instanceDir, "executions");
  for (const name of await readdir(base).catch(() => [] as string[])) {
    const dir = join(base, name);
    const pgid = Number(await readFile(join(dir, "pgid"), "utf8").catch(() => "0"));
    if (pgid > 0) {
      try {
        process.kill(-pgid, "SIGKILL");
      } catch {
        // already exited
      }
    }
    if (!(await exists(join(dir, "exit")))) await writeFile(join(dir, "lost"), "").catch(() => {});
  }
}

/**
 * Kept for callers written before the fake carried the permission-scoped surface itself: the
 * provider from {@link createFakeSandbox} is returned as it is.
 */
export function fakeOperationFacade(_root: string, provider: SandboxProvider): SandboxProvider {
  return provider;
}
