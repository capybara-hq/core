import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { extname } from "node:path";
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
}

/** 一个副本（独立子进程）的句柄。 */
export interface ReplicaHandle {
  index: 0 | 1;
  /** 该副本实际监听的 HTTP 端口（127.0.0.1）。 */
  port: number;
  /** 该副本子进程 pid。 */
  pid: number;
}

/** 两个独立进程的内核副本 + 严格交替的请求入口。 */
export interface Harness {
  /** 严格交替发往两个副本：第 1、3、5… 次到 replica 0，第 2、4、6… 次到 replica 1。 */
  request(path: string, init?: RequestInit): Promise<Response>;
  replicas: [ReplicaHandle, ReplicaHandle];
  /** 本 harness 独占数据库的连接串，测试可直接连上去查表。 */
  dbUrl: string;
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

/** 启动一个副本子进程，等它通过 IPC 报告 ready。失败时抛出带 输出尾部的错误（不含配置）。 */
async function startReplica(
  config: Record<string, unknown>,
): Promise<{ runner: Runner; port: number }> {
  const child = spawn(process.execPath, runnerArgv(runnerPath), {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
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
    child.send({ type: "start", config });
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
      resolveFrom: opts.resolveFrom ?? process.cwd(),
      pluginConfig: opts.pluginConfig ?? {},
      roles: ["api", "worker", "gateway"],
    };

    const started = await Promise.allSettled([startReplica(config), startReplica(config)]);
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
      async request(path, init) {
        const i = calls++ % 2;
        const r = replicas[i] as ReplicaHandle;
        const dead = (i === 0 ? a : b).runner.crashed;
        if (dead !== undefined) {
          throw new Error(
            `replica ${i} (pid ${r.pid}) ${dead}\n${(i === 0 ? a : b).runner.output()}`,
          );
        }
        return await fetch(`http://127.0.0.1:${r.port}${path}`, init);
      },
    };
  } catch (e) {
    await stop();
    throw e;
  }
}
