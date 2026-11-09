import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  defineExtension,
  type ExecResult,
  FileSystemGoneError,
  type FileSystemHandle,
  SANDBOX_EXTENSION_POINT,
  SANDBOX_TAG_RE,
  SandboxGoneError,
  type SandboxHandle,
  type SandboxLimits,
  type SandboxProvider,
  validateSandboxPath,
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
 * - `root/delays.json` (optional): `{ create?, resume?, suspend?, destroy?, exec? }` in ms, slow
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
 *
 * `exec` runs the command with `/bin/sh -c` in the instance's directories: `/workspace`, `/skills`
 * and `/tmp` in the command are replaced by their host directories and mapped back in the output;
 * a timeout or an abort kills the whole process group (SIGKILL). An already aborted signal fails an
 * operation at once.
 */

const Deployment = z.object({ root: z.string().min(1) });

/** 慢操作的延迟（毫秒），写在 `root/delays.json`。 */
export interface FakeSandboxDelays {
  create?: number;
  resume?: number;
  suspend?: number;
  destroy?: number;
  /** Held before the command starts (inside `exec`, so the caller's lease is held meanwhile). */
  exec?: number;
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
// not detached: the command stays in this process group, so in the caller's session
const child = spawn(argv[1], argv.slice(2), { stdio: "inherit" });
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
export function createFakeSandbox(rootDir: string): SandboxProvider {
  // 用真实路径（macOS 的临时目录经符号链接），pwd 等输出才能换回沙箱路径
  mkdirSync(rootDir, { recursive: true });
  const root = realpathSync(rootDir);
  const binDir = join(root, "bin");
  writeShims(binDir);
  const log = (line: string) => appendFile(join(root, "ops.log"), `${line}\n`);
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
  };
  const real = async (h: SandboxHandle, p: string) => {
    const errors = validateSandboxPath(p);
    if (errors.length > 0) throw new Error(errors.join("; "));
    const m = await mounts(h);
    const r = Object.keys(m).find((k) => p === k || p.startsWith(`${k}/`)) as string;
    return join(m[r] as string, p.slice(r.length));
  };

  const provider: SandboxProvider = {
    concurrentExec: true as const,

    async createFileSystem({ name, limits, signal }): Promise<FileSystemHandle> {
      await delay("create", signal);
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
    const { root } = ctx.config as z.infer<typeof Deployment>;
    ctx.provide(SANDBOX_EXTENSION_POINT, createFakeSandbox(root));
  },
});
