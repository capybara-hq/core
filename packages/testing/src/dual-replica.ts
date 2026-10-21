import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { startTestPostgres, startTestRedis, type TestContainer } from "./containers.js";

/** 双副本测试工具的选项。 */
export interface DualReplicaOptions {
  /** 要加载的插件（绝对路径、file URL，或相对 `resolveFrom` 解析的包名）。 */
  plugins: string[];
  /** 解析裸包名插件的目录，默认调用方的 `process.cwd()`（与 `createKernel` 的 resolveFrom 同义）。 */
  resolveFrom?: string;
  /** 部署级插件配置，按插件名索引。 */
  pluginConfig?: Record<string, unknown>;
  /**
   * 复用已有的 PostgreSQL（管理员连接串，需能 CREATE DATABASE）。
   * 省略则自己起容器，stop() 时关闭；传入则只创建并在 stop() 时删除本 harness 的 `cap_*` 库。
   */
  pgUrl?: string;
  /**
   * 复用已有的 Redis。省略则每个 harness 自己起一个容器（完全隔离）；
   * 传入时不做隔离，调用方须保证同一 Redis 不被多个同时存活的 harness 共用。
   */
  redisUrl?: string;
  /**
   * 额外的内核配置，深合并进副本配置（如 `{ auth: { cookieSecure: false, setupToken: "…" } }`）。
   * 与 harness 自身设定的键冲突时以这里为准（数组整体替换）。经 IPC 传给副本，不进 argv / env。
   * harness 默认开启 `pluginPermissions.autoApprove`（插件权限自动批准），传 `false` 可关闭。
   */
  config?: Record<string, unknown>;
}

/** 一个副本（独立子进程）的句柄。 */
export interface ReplicaHandle {
  index: 0 | 1;
  /** 该副本实际监听的 HTTP 端口（127.0.0.1）。 */
  port: number;
  /** 该副本子进程 pid。 */
  pid: number;
}

/** 副本在响应头里标明自己的序号（runner 把 `http.replicaId` 设为 `"0"` / `"1"`）。 */
export const REPLICA_HEADER = "x-capybara-replica";

/**
 * 读响应头 `x-capybara-replica`，得到处理该请求的副本序号；不是 harness 副本发出的响应（没有该头或值不是 0 / 1）
 * 返回 undefined。直接 `fetch` 某个副本端口（如 SSE）时用它确认落点。
 */
export function replicaOf(res: Response): 0 | 1 | undefined {
  const v = res.headers.get(REPLICA_HEADER);
  return v === "0" ? 0 : v === "1" ? 1 : undefined;
}

/** `Harness.request` 的返回值：普通 `Response` 加上处理它的副本序号（取自 `x-capybara-replica` 响应头）。 */
export type ReplicaResponse = Response & { readonly replica: 0 | 1 };

/** 两个独立进程的内核副本 + 严格交替的请求入口。 */
export interface Harness {
  /**
   * 严格交替发往两个副本：第 1、3、5… 次到 replica 0，第 2、4、6… 次到 replica 1。
   * 返回值的 `replica` 取自响应头 `x-capybara-replica`；响应头缺失或与目标不符时抛错。
   */
  request(path: string, init?: RequestInit): Promise<ReplicaResponse>;
  replicas: [ReplicaHandle, ReplicaHandle];
  /** 本 harness 独占数据库的连接串，测试可直接连上去查表。 */
  dbUrl: string;
  /**
   * 模拟副本硬崩溃：对该副本子进程发 SIGKILL 并等它退出（不走优雅停机）。之后发往它的请求直接抛错；
   * 另一个副本照常工作。已退出时是空操作。
   */
  kill(index: 0 | 1): Promise<void>;
  /** 停两个副本（15s 后 SIGKILL）、删临时库、关自有容器；幂等。 */
  stop(): Promise<void>;
}

const STOP_TIMEOUT_MS = 15_000;
const START_TIMEOUT_MS = 60_000;
const STDERR_TAIL = 4000;

/** 子进程 + 其输出尾部 + 退出信息。 */
interface Runner {
  child: ChildProcess;
  output: () => string;
  exited: Promise<void>;
  /** 子进程已退出时的描述（含退出码/信号），否则 undefined。 */
  crashed: string | undefined;
}

/** 新建随机名数据库，返回 `{ url, drop }`。 */
async function createFreshDatabase(adminUrl: string) {
  const name = `cap_${randomBytes(6).toString("hex")}`;
  const admin = async (sql: string) => {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      await client.query(sql);
    } finally {
      await client.end();
    }
  };
  await admin(`CREATE DATABASE ${name}`);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    drop: () => admin(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`),
  };
}

/** runner 与本文件同目录；源码下是 .ts，编译后是 .js。 */
const runnerPath = fileURLToPath(
  new URL(`./replica-runner${extname(fileURLToPath(import.meta.url))}`, import.meta.url),
);

/**
 * 子进程的 node 参数。`.ts` 的 runner（monorepo / 开发态）需要 tsx 与源码导出条件；
 * 编译后的 `.js` runner（发布态）直接用 node，不依赖 tsx。
 */
export function runnerArgv(runnerPath: string): string[] {
  return runnerPath.endsWith(".ts")
    ? ["--import", "tsx", "--conditions=@capybara-hq/source", runnerPath]
    : [runnerPath];
}

/** 仓库根的 tsconfig.base.json（仅 monorepo 源码态存在）。 */
const REPO_TSCONFIG = fileURLToPath(new URL("../../../tsconfig.base.json", import.meta.url));

/**
 * 子进程的环境变量。`.ts` 的 runner 额外设置 `TSX_TSCONFIG_PATH` 指向仓库的 tsconfig.base.json：
 * tsx 只认子进程 cwd 下（且 include 覆盖到的）tsconfig，否则内核源码丢掉 experimentalDecorators，
 * Nest 装饰器无法编译。编译后的 `.js` runner 不经 tsx，环境原样传入。
 */
export function runnerEnv(
  runnerPath: string,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return runnerPath.endsWith(".ts") ? { ...env, TSX_TSCONFIG_PATH: REPO_TSCONFIG } : env;
}

/** 启动一个副本子进程，等它通过 IPC 报告 ready。失败时抛出带 输出尾部的错误（不含配置）。 */
async function startReplica(
  config: Record<string, unknown>,
  index: 0 | 1,
): Promise<{ runner: Runner; port: number }> {
  const child = spawn(process.execPath, runnerArgv(runnerPath), {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: runnerEnv(runnerPath),
    cwd: fileURLToPath(new URL("..", import.meta.url)),
  });
  let tail = "";
  const onData = (b: Buffer) => {
    tail = (tail + b.toString()).slice(-STDERR_TAIL);
  };
  child.stderr?.on("data", onData);
  child.stdout?.on("data", onData);
  const runner: Runner = {
    child,
    output: () => tail,
    exited: Promise.resolve(),
    crashed: undefined,
  };
  runner.exited = new Promise<void>((resolve) =>
    child.once("exit", (code, signal) => {
      runner.crashed = `exited with ${signal ? `signal ${signal}` : `code ${code}`}`;
      resolve();
    }),
  );
  const exited = runner.exited;

  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("replica start timed out")), START_TIMEOUT_MS);
    const fail = (why: string) => {
      clearTimeout(timer);
      reject(new Error(`replica failed to start: ${why}\n${tail}`));
    };
    child.on("message", (m: { type: string; port?: number; error?: string }) => {
      if (m.type === "ready" && typeof m.port === "number") {
        clearTimeout(timer);
        resolve(m.port);
      } else if (m.type === "failed") fail(m.error ?? "unknown");
    });
    child.once("exit", (code) => fail(`runner exited with code ${code}`));
    child.once("error", (e) => fail(e.message));
    child.send({ type: "start", config: { ...config, replicaId: String(index) } });
  }).catch(async (e) => {
    child.kill("SIGKILL");
    await exited;
    throw e;
  });
  return { runner, port };
}

/**
 * 启动两个共享同一套 PG / Redis、同一 masterKey 的内核副本，**每个副本一个独立子进程**，
 * 模块缓存、进程内状态完全隔离，贴近生产多副本。请求经真实 HTTP 交替发往两个副本。
 * 两个副本都就绪后才 resolve；用来暴露「只在多副本下才出现」的进程内状态缺陷。
 */
export async function createDualReplicaHarness(opts: DualReplicaOptions): Promise<Harness> {
  const owned: TestContainer[] = [];
  const runners: Runner[] = [];
  let dropDb: (() => Promise<void>) | undefined;
  let stopPromise: Promise<void> | undefined;

  const stopRunner = async (r: Runner) => {
    if (r.child.exitCode !== null || r.child.signalCode !== null) return;
    if (r.child.connected) r.child.send({ type: "stop" });
    let timer: NodeJS.Timeout | undefined;
    const killed = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        r.child.kill("SIGKILL");
        resolve();
      }, STOP_TIMEOUT_MS);
    });
    await Promise.race([r.exited, killed]);
    clearTimeout(timer);
    await r.exited;
  };

  const stop = (): Promise<void> => {
    stopPromise ??= (async () => {
      await Promise.allSettled(runners.map(stopRunner));
      await Promise.allSettled([dropDb?.()]);
      await Promise.allSettled(owned.map((c) => c.stop()));
    })();
    return stopPromise;
  };

  try {
    let pgUrl = opts.pgUrl;
    if (pgUrl === undefined) {
      const c = await startTestPostgres();
      owned.push(c);
      pgUrl = c.url;
    }
    let redisUrl = opts.redisUrl;
    if (redisUrl === undefined) {
      const c = await startTestRedis();
      owned.push(c);
      redisUrl = c.url;
    }
    const db = await createFreshDatabase(pgUrl);
    dropDb = db.drop;
    const config = {
      dbUrl: db.url,
      redisUrl,
      masterKey: randomBytes(32).toString("base64"),
      plugins: opts.plugins,
      // 副本进程的 cwd 不是调用方的 cwd，相对路径必须先按调用方 cwd 绝对化再经 IPC 传过去
      resolveFrom: resolve(opts.resolveFrom ?? process.cwd()),
      pluginConfig: opts.pluginConfig ?? {},
      roles: ["api", "worker", "gateway"],
      overrides: opts.config ?? {},
    };

    const started = await Promise.allSettled([startReplica(config, 0), startReplica(config, 1)]);
    for (const s of started) if (s.status === "fulfilled") runners.push(s.value.runner);
    const failed = started.find((s) => s.status === "rejected");
    if (failed) throw (failed as PromiseRejectedResult).reason;
    const [a, b] = started.map(
      (s) => (s as PromiseFulfilledResult<Awaited<ReturnType<typeof startReplica>>>).value,
    ) as [Awaited<ReturnType<typeof startReplica>>, Awaited<ReturnType<typeof startReplica>>];
    const replicas: [ReplicaHandle, ReplicaHandle] = [
      { index: 0, port: a.port, pid: a.runner.child.pid as number },
      { index: 1, port: b.port, pid: b.runner.child.pid as number },
    ];
    let calls = 0;
    return {
      replicas,
      dbUrl: db.url,
      stop,
      async kill(index) {
        const r = (index === 0 ? a : b).runner;
        if (r.child.exitCode === null && r.child.signalCode === null) r.child.kill("SIGKILL");
        await r.exited;
      },
      async request(path, init) {
        const i = calls++ % 2;
        const r = replicas[i] as ReplicaHandle;
        const dead = (i === 0 ? a : b).runner.crashed;
        if (dead !== undefined) {
          throw new Error(
            `replica ${i} (pid ${r.pid}) ${dead}\n${(i === 0 ? a : b).runner.output()}`,
          );
        }
        const res = await fetch(`http://127.0.0.1:${r.port}${path}`, init);
        const replica = replicaOf(res);
        if (replica !== i) {
          await res.body?.cancel();
          throw new Error(
            `response from port ${r.port} has ${REPLICA_HEADER}=${replica}, want ${i}`,
          );
        }
        return Object.assign(res, { replica }) as ReplicaResponse;
      },
    };
  } catch (e) {
    await stop();
    throw e;
  }
}
