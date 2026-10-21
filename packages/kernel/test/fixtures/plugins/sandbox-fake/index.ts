import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  definePlugin,
  type ExecResult,
  SANDBOX_CAPABILITY,
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
 * - 实例目录不在时 exec / readFile / writeFile / stat 抛 `SandboxGoneError`；
 * - `root/delays.json`（可选）：`{ create?, resume?, suspend?, destroy? }` 毫秒，模拟慢操作（每次操作时读取）。
 * 模拟 `gone`：测试删掉 `root/instances/<id>`（{@link removeFakeSandbox}），之后 resume 返回 `gone`。
 *
 * `exec` 用 `/bin/sh -c` 在实例目录里真的执行命令：命令里的 `/workspace`、`/skills`、`/tmp` 换成实例目录下的对应目录，
 * 输出里再换回来；超时或中止时杀掉整个进程组。只执行测试自己写的命令，**没有任何隔离**。
 */

const Deployment = z.object({ root: z.string().min(1) });

/** 慢操作的延迟（毫秒），写在 `root/delays.json`。 */
export interface FakeSandboxDelays {
  create?: number;
  resume?: number;
  suspend?: number;
  destroy?: number;
}

/** create 时记下的参数（`root/instances/<id>/meta.json`）。 */
export interface FakeSandboxMeta {
  name: string;
  image: string;
  limits: SandboxLimits;
}

const instanceDir = (root: string, id: string) => join(root, "instances", id);

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
  const log = (line: string) => appendFile(join(root, "ops.log"), `${line}\n`);
  const delay = async (op: keyof FakeSandboxDelays, signal: AbortSignal) => {
    const raw = await readFile(join(root, "delays.json"), "utf8").catch(() => "{}");
    await sleep((JSON.parse(raw) as FakeSandboxDelays)[op] ?? 0, signal);
  };
  const fsRoot = (h: SandboxHandle) => join(instanceDir(root, h.id), "fs");
  const requireRunning = async (h: SandboxHandle) => {
    const s = await fakeSandboxState(root, h.id);
    if (s === null) throw new SandboxGoneError(`fake sandbox ${h.id} is gone`);
    if (s !== "running") throw new Error(`fake sandbox ${h.id} is not running (${s})`);
  };
  const real = (h: SandboxHandle, p: string) => {
    const errors = validateSandboxPath(p);
    if (errors.length > 0) throw new Error(errors.join("; "));
    return join(fsRoot(h), p);
  };

  return {
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
        await writeFile(join(instanceDir(root, h.id), "state"), "suspended");
      }
      await log(`suspend ${h.id}`);
    },

    async destroy(h, signal) {
      await delay("destroy", signal);
      await rm(instanceDir(root, h.id), { recursive: true, force: true });
      await log(`destroy ${h.id}`);
    },

    async destroyByName(name, signal) {
      await delay("destroy", signal);
      const ids = await readdir(join(root, "instances")).catch(() => [] as string[]);
      for (const id of ids) {
        if ((await fakeSandboxMeta(root, id))?.name === name) {
          await rm(instanceDir(root, id), { recursive: true, force: true });
        }
      }
      await log(`destroy-by-name ${name}`);
    },

    async exec(h, args): Promise<ExecResult> {
      await requireRunning(h);
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
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            HOME: join(base, "workspace"),
            ...args.env,
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
        const timer = setTimeout(() => {
          timedOut = true;
          kill();
        }, args.timeoutMs);
        const onAbort = () => kill();
        args.signal.addEventListener("abort", onAbort, { once: true });
        child.once("close", (code) => {
          clearTimeout(timer);
          args.signal.removeEventListener("abort", onAbort);
          resolve({
            exitCode: killed ? null : code,
            stdout: back(out.toString("utf8")),
            stderr: back(err.toString("utf8")),
            truncated,
            timedOut,
          });
        });
      });
    },

    async readFile(h, path, opts) {
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

    async writeFile(h, path, data) {
      await requireRunning(h);
      const p = real(h, path);
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, data);
    },

    async stat(h, path) {
      await requireRunning(h);
      const s = await stat(real(h, path)).catch(() => null);
      return s === null ? null : { size: s.size, isDir: s.isDirectory() };
    },
  };
}

/** 测试用 `sandbox@1`：部署配置 `{ root }`，见文件头注释。 */
export default definePlugin({
  name: "sandbox-fake",
  version: "0.1.0",
  sdk: "^0.1.0",
  provides: [SANDBOX_CAPABILITY],
  // 只用部署配置与本地文件，不用任何需要声明的平台能力
  permissions: {},
  config: { deployment: Deployment },
  setup(ctx) {
    const { root } = ctx.config as z.infer<typeof Deployment>;
    ctx.provide(SANDBOX_CAPABILITY, createFakeSandbox(root));
  },
});
