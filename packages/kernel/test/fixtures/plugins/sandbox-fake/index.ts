import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  defineExtension,
  type ExecResult,
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
 * 测试用 `sandbox@1`（只用于测试，绝不能用于生产）。
 *
 * 「提供方那边」的状态全在部署配置 `root` 目录里（像 Docker 守护进程，多个内核副本共用一个 root 即共用同一批实例）：
 * - `root/instances/<id>/state`：`running` / `suspended`；`meta.json`：create 收到的 name、image、limits；
 * - `root/instances/<id>/fs/{workspace,skills,tmp}`：沙箱内 `/workspace`、`/skills`、`/tmp` 的内容（休眠后保留）；
 * - `root/ops.log`：每个操作一行 `<op> <id> [name]`（create / resume / resume-gone / suspend / destroy /
 *   destroy-by-name `<name>`），测试据此计数；
 * - 实例目录不在时 exec / readFile / writeFile / stat / killAll 抛 `SandboxGoneError`；实例在但 `suspended` 时
 *   它们先把它启动起来（契约的自动启动，ops.log 记 `autostart <id>`）；
 * - `root/instances/<id>/procs/<pid>`: running exec commands (process group id), content = the
 *   holder tag (empty without one); `killAll` kills them all (ops.log `kill-all <id>`),
 *   `killTagged` only those with one of the tags (ops.log `kill-tagged <id> <tag,…>`);
 * - every finished exec logs `exec <id> <tag or -> <startMs> <endMs>` (tests check overlap);
 * - concurrent use is declared (`concurrentExec`, `killTagged`);
 * - `root/delays.json` (optional): `{ create?, resume?, suspend?, destroy?, exec? }` in ms, slow
 *   operations (read at each operation); `exec` holds the command open before it starts.
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
 * 模拟 `gone`：测试删掉 `root/instances/<id>`（{@link removeFakeSandbox}），之后 resume 返回 `gone`。
 *
 * `exec` 用 `/bin/sh -c` 在实例目录里真的执行命令：命令里的 `/workspace`、`/skills`、`/tmp` 换成实例目录下的对应目录，
 * 输出里再换回来；超时或中止时杀掉整个进程组（SIGKILL）。每个操作开始前已中止的 signal 让它立即失败，慢操作的延迟也响应中止。
 * 只执行测试自己写的命令，**没有任何隔离**。
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
  image: string;
  limits: SandboxLimits;
}

const instanceDir = (root: string, id: string) => join(root, "instances", id);

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
  const fsRoot = (h: SandboxHandle) => join(instanceDir(root, h.id), "fs");
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
  /** Kills every process the instance started: exec commands and shim sessions (by group). */
  const killEverything = async (h: SandboxHandle) => {
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
  const real = (h: SandboxHandle, p: string) => {
    const errors = validateSandboxPath(p);
    if (errors.length > 0) throw new Error(errors.join("; "));
    return join(fsRoot(h), p);
  };

  return {
    concurrentExec: true,

    async create({ name, image, limits, signal }) {
      await delay("create", signal);
      const id = `fake-${randomUUID().slice(0, 8)}`;
      const dir = instanceDir(root, id);
      for (const r of ["workspace", "skills", "tmp"]) {
        await mkdir(join(dir, "fs", r), { recursive: true });
      }
      await writeFile(join(dir, "meta.json"), JSON.stringify({ name, image, limits }));
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
      const base = fsRoot(h);
      const command = args.command.replace(
        ROOT_RE,
        (_m, pre: string, r: string) => `${pre}${base}${r}`,
      );
      const cwd = real(h, args.cwd ?? "/workspace");
      const back = (s: string) => s.split(base).join("");
      return new Promise<ExecResult>((resolve) => {
        const child = spawn("/bin/sh", ["-c", command], {
          cwd,
          env: {
            HOME: join(base, "workspace"),
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
          void log(`exec ${h.id} ${args.tag ?? "-"} ${startedAt} ${Date.now()}`)
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
      const p = real(h, path);
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
      const p = real(h, path);
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, data);
    },

    async stat(h, path, signal) {
      signal.throwIfAborted();
      await requireRunning(h);
      const s = await stat(real(h, path)).catch(() => null);
      return s === null ? null : { size: s.size, isDir: s.isDirectory() };
    },
  };
}

/** 测试用 `sandbox@1`：部署配置 `{ root }`，见文件头注释。 */
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
