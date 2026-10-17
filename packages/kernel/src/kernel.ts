import { fileURLToPath } from "node:url";
import type { PluginContext } from "@capybara-hq/plugin-sdk";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { changedPaths, configFields, getPath, secretValues, setPath } from "./config/fields.js";
import { type ConfigSource, resolveConfig } from "./config/load.js";
import { type KernelConfig, KernelConfigSchema } from "./config/schema.js";
import {
  type ConversationBusMessage,
  conversationTopic,
  EventLog,
} from "./conversations/event-log.js";
import { createBus, createBusSubscriber } from "./ctx/bus.js";
import type { KernelDeps } from "./ctx/create-ctx.js";
import { createKeyring } from "./ctx/secrets.js";
import { kernelDb } from "./db/kernel-schema.js";
import { migrate } from "./db/migrator.js";
import { createDb } from "./db/pool.js";
import { ApiModule } from "./http/api.module.js";
import { createHttpApp, type KernelHttp, type KernelHttpApp } from "./http/app.js";
import { AccountsService } from "./identity/accounts.js";
import { SettingsService } from "./identity/settings.js";
import { createLogger, type KernelLogger } from "./log.js";
import { PluginHost } from "./plugins/host.js";
import { OrgPluginConfigs } from "./plugins/org-config.js";
import { RunAbort } from "./runtime/abort.js";
import { KyselyCheckpointSaver } from "./runtime/checkpointer.js";
import { ConversationLock } from "./runtime/conversation-lock.js";
import { LangGraphLoop } from "./runtime/langgraph-loop.js";
import type { AgentLoop } from "./runtime/loop.js";
import type { ModelStepDeps, StreamSink } from "./runtime/model-call.js";
import { ProviderRegistry } from "./runtime/providers.js";
import { OrgQuota } from "./runtime/quota.js";
import { RunQueue } from "./runtime/run-queue.js";
import { type RunHooks, RunWorker } from "./runtime/run-worker.js";

/**
 * 内核迁移目录。src/ 与 dist/ 都在包根下一层，所以统一指向 `<包根>/src/migrations`：
 * 用 tsx 从源码运行与运行 tsc 产物时解析到同一个目录（SQL 文件不进 dist，随包发布 src/migrations）。
 */
export const KERNEL_MIGRATIONS_DIR = fileURLToPath(new URL("../src/migrations/", import.meta.url));

/** 内核 PG schema。 */
export const KERNEL_SCHEMA = "capybara";

/** 优雅停机的总时限：超时后强制关闭剩余资源。 */
const STOP_TIMEOUT_MS = 30_000;

/**
 * 停机分阶段预算：每阶段实际等待 `min(阶段预算, 总剩余)`，按顺序为
 * migrate（中止进行中的内核迁移并等其会话结束）2s → http 10s → runs 10s → plugins 5s，合计 27s，
 * 余下 3s 给 bus / redis / pg 收尾（这三步共享总剩余）。
 * http 阶段是一个截止时间：先等进行中的监听完成（否则关闭会与监听交错留下端口），再关闭 HTTP，
 * 两步共用这 10s；到点仍未关完就强制断开所有连接。
 * runs 阶段（从原插件阶段的 15s 中划出 10s）：本进程的运行收到停机信号，在下一个步骤边界停下、
 * 任务回到队列；超出预算的运行交给 BullMQ stalled 机制由其他 worker 续跑（spec 8.5）。
 * 因此任一前序阶段卡死时，插件队列仍至少有 5s 排空，总时长不超过 30s。
 */
export const STOP_BUDGET_MS = {
  migrate: 2_000,
  http: 10_000,
  runs: 10_000,
  plugins: 5_000,
} as const;

/** runs 阶段里留给强制关闭 worker 的余量（预算的其余部分用于等运行到达步骤边界）。 */
const RUNS_FORCE_CLOSE_MS = 500;

/** 运行编排相关的内核服务（后续任务的 loop / SSE 使用）。 */
export interface KernelRuns {
  readonly eventLog: EventLog;
  readonly registry: ProviderRegistry;
  readonly queue: RunQueue;
  readonly lock: ConversationLock;
  readonly quota: OrgQuota;
  readonly abort: RunAbort;
  /** 构造 loop 用的单步模型调用依赖。 */
  readonly stepDeps: ModelStepDeps;
}

/** 运行中的内核实例。 */
export interface Kernel {
  /** 内核 HTTP：进程内注入请求、列出路由。 */
  readonly http: KernelHttp;
  readonly host: PluginHost;
  /** 组织级插件启用状态与配置（密钥字段加密存储）。 */
  readonly orgPluginConfigs: OrgPluginConfigs;
  /** 内核总线（命名空间 `kernel`）。 */
  readonly bus: PluginContext["bus"];
  /** 运行编排服务。 */
  readonly runs: KernelRuns;
  readonly log: KernelLogger;
  /** 当前生效的配置（热更新只替换 `hot` 字段）。 */
  readonly config: KernelConfig;
  /**
   * 实际监听的端口；尚未 start 或已 stop 时为 undefined。
   * 所有角色都监听：worker-only 只暴露 `/healthz` 与 `/readyz`（供 K8s 探针）。
   */
  readonly port: number | undefined;
  start(): Promise<void>;
  /** 优雅停机：幂等，总时长不超过 30s。 */
  stop(): Promise<void>;
}

/** createKernel 的可选项。 */
export interface KernelOptions {
  /** 配置来源；提供 `watch` 时启用热更新。 */
  source?: ConfigSource;
  /** 解析插件裸包名的目录，默认 `process.cwd()`；相对路径按当前 cwd 解析。 */
  resolveFrom?: string;
  /** 默认按 `config.log.level` 新建 JSON logger。 */
  logger?: KernelLogger;
  /** 热更新时与来源原始值合并的环境变量，默认 `process.env`。 */
  env?: NodeJS.ProcessEnv;
  /**
   * 运行使用的 AgentLoop 工厂（测试用）。默认是 {@link LangGraphLoop}：checkpoint 存在内核的
   * `KyselyCheckpointSaver`，worker 崩溃后其他副本从 checkpoint 续跑。
   */
  loop?: (deps: ModelStepDeps) => AgentLoop;
  /** 运行 worker 的测试钩子。 */
  runHooks?: RunHooks;
}

/**
 * 可热更新字段的应用函数：键为 schema 中标记 `hot` 的点路径。
 * 新增 hot 字段而漏写这里时 createKernel 直接抛错，避免「标了 hot 但从不生效」。
 */
const HOT_APPLIERS: Record<string, (k: { log: KernelLogger }, value: unknown) => void> = {
  "log.level": (k, v) => k.log.setLevel(String(v)),
  // 并发上限由运行时在每次取额度时经 `config()` 读取当前值，替换配置即生效，无需额外动作。
  "runtime.orgConcurrency": () => {},
};

const HOT_PATHS = configFields(KernelConfigSchema)
  .filter((f) => f.meta?.hot)
  .map((f) => f.path);

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** 运行内核迁移与所有已配置插件的迁移（不调用插件 setup，不连接 Redis）。 */
export async function migrateAll(
  config: KernelConfig,
  opts: { resolveFrom?: string } = {},
): Promise<{ schema: string; plugin?: string; applied: string[] }[]> {
  const connectTimeoutMs = config.db.connectTimeoutMs;
  const kernel = await migrate(
    config.db.url,
    { schema: KERNEL_SCHEMA, dir: KERNEL_MIGRATIONS_DIR },
    { connectTimeoutMs },
  );
  const plugins = await PluginHost.migrateOnly(config.plugins, {
    dbUrl: config.db.url,
    connectTimeoutMs,
    ...(opts.resolveFrom !== undefined && { resolveFrom: opts.resolveFrom }),
  });
  return [{ schema: KERNEL_SCHEMA, applied: kernel.applied }, ...plugins];
}

/** 构建内核：创建连接（Redis 惰性连接）、插件宿主与 HTTP 应用；`start()` 才真正连接、迁移、加载插件与监听。 */
export async function createKernel(
  config: KernelConfig,
  opts: KernelOptions = {},
): Promise<Kernel> {
  for (const p of HOT_PATHS) {
    if (!HOT_APPLIERS[p]) throw new Error(`config field ${p} is marked hot but has no applier`);
  }
  const env = opts.env ?? process.env;
  const log = opts.logger ?? createLogger(config.log.level);
  log.setLevel(config.log.level);
  log.addSecrets(secretValues(KernelConfigSchema, config));

  let current = config;
  let started = false;
  let stopRequested = false;
  let stopPromise: Promise<void> | undefined;
  let startPromise: Promise<void> | undefined;
  let port: number | undefined;
  let listenPromise: Promise<number> | undefined;
  /** 进行中的内核迁移；stop() 中止它并等其会话结束。 */
  let migratePromise: Promise<unknown> | undefined;
  const startAbort = new AbortController();
  let unwatch: (() => void) | undefined;

  const redis = new Redis(config.redis.url, { lazyConnect: true });
  redis.on("error", (err: Error) => log.error("redis connection error", { err }));
  const busSubscriber = createBusSubscriber(() => new Redis(config.redis.url), log);
  const db = createDb(
    config.db.url,
    config.db.poolMax,
    (err) => log.error("pg idle client error", { err }),
    { connectTimeoutMs: config.db.connectTimeoutMs },
  );
  const keyring = createKeyring(
    Buffer.from(config.masterKey, "base64"),
    config.masterKeyPrevious.map((k) => Buffer.from(k, "base64")),
  );
  const deps: KernelDeps = {
    db,
    dbUrl: config.db.url,
    connectTimeoutMs: config.db.connectTimeoutMs,
    redis,
    busSubscriber,
    redisUrl: config.redis.url,
    keyring,
    runWorkers: config.roles.includes("worker"),
    log,
  };
  const host = new PluginHost(deps, config.pluginConfig, {
    ...(opts.resolveFrom !== undefined && { resolveFrom: opts.resolveFrom }),
    onSecrets: (v) => log.addSecrets(v),
  });
  const orgPluginConfigs = new OrgPluginConfigs(kernelDb(db), keyring, host, {
    onSecrets: (v) => log.addOrgSecrets(v),
  });
  const servePlugins = config.roles.includes("api") || config.roles.includes("gateway");
  const kdb = kernelDb(db);
  const bus = createBus(redis, busSubscriber, "kernel", log);
  const eventLog = new EventLog(kdb, bus, log);
  const registry = new ProviderRegistry(host, redis, log);
  const lock = new ConversationLock(redis, log);
  const quota = new OrgQuota(redis);
  const abort = new RunAbort(redis, bus);
  const runQueue = new RunQueue(kdb, eventLog, lock, config.redis.url, log);
  const checkpoints = new KyselyCheckpointSaver(kdb);
  const loopFactory =
    opts.loop ?? ((d: ModelStepDeps): AgentLoop => new LangGraphLoop(checkpoints, d));
  /**
   * 流式增量发布到会话频道（与 `{ kind: "events" }` 共用 `conv.<id>`），任意副本上的订阅方都能收到。
   * 发布失败只记日志：增量只是草稿，最终内容以日志中的 assistant_message 为准。
   */
  const sinkFor =
    (conversationId: string): StreamSink =>
    (d) => {
      const msg: ConversationBusMessage = {
        kind: "delta",
        runId: d.runId,
        step: d.step,
        delta: d.kind,
        ...(d.text !== undefined && { text: d.text }),
      };
      bus
        .publish(conversationTopic(conversationId), msg)
        .catch((err) => log.warn("stream delta publish failed", { conversationId, err }));
    };
  const stepDeps: ModelStepDeps = { db: kdb, eventLog, registry, config: () => current, log };
  const runs: KernelRuns = { eventLog, registry, queue: runQueue, lock, quota, abort, stepDeps };
  let runWorker: RunWorker | undefined;
  /** 构建失败时释放已创建的连接对象（Redis / PG 池 / 总线订阅），再抛出。 */
  const releaseConnections = async (): Promise<void> => {
    redis.disconnect();
    await busSubscriber.close().catch(() => {});
    await db.destroy().catch(() => {});
  };
  let httpApp: KernelHttpApp;
  try {
    httpApp = await createHttpApp({
      log,
      health: {
        isStopping: () => stopRequested,
        log,
        checks: {
          pg: async () => {
            await sql`select 1`.execute(db);
          },
          redis: async () => {
            if (redis.status !== "ready") throw new Error(`redis status ${redis.status}`);
            await redis.ping();
          },
        },
      },
      serveApi: config.roles.includes("api"),
      servePlugins,
      apiModule: ApiModule.register({
        db: kdb,
        redis,
        keyring,
        config: () => current,
        log,
        host,
        orgPluginConfigs,
        bus,
        eventLog,
        registry,
        runs: {
          ensureRun: (id) => runQueue.ensureRun(id),
          requestAbort: (runId, by) => abort.request(runId, by),
        },
      }),
      trustProxy: config.http.trustProxy,
    });
  } catch (e) {
    await releaseConnections();
    throw e;
  }

  /** 热更新：重新校验；只应用 hot 字段，其余变化 warn 并列出需重启的键；校验失败保持原配置。 */
  const onConfigChange = (raw: unknown): void => {
    let next: KernelConfig;
    try {
      next = resolveConfig(raw, env);
    } catch (e) {
      log.error("config reload rejected; keeping current config", { error: errMsg(e) });
      return;
    }
    log.addSecrets(secretValues(KernelConfigSchema, next));
    const changed = changedPaths(KernelConfigSchema, current, next);
    if (changed.length === 0) return;
    const hot = changed.filter((p) => HOT_PATHS.includes(p));
    const restart = changed.filter((p) => !HOT_PATHS.includes(p));
    const updated = structuredClone(current);
    const applied: string[] = [];
    for (const p of hot) {
      try {
        (HOT_APPLIERS[p] as (typeof HOT_APPLIERS)[string])({ log }, getPath(next, p));
        setPath(updated as unknown as Record<string, unknown>, p, getPath(next, p));
        applied.push(p);
      } catch (e) {
        log.error("config reload: cannot apply field; keeping current value", {
          key: p,
          error: errMsg(e),
        });
      }
    }
    current = updated;
    if (applied.length > 0) log.info("config reloaded", { applied });
    if (restart.length > 0) {
      log.warn("config changed but requires restart to take effect", { keys: restart });
    }
  };

  /** 部署尚无活跃企业管理员时提示去初始化；查询失败只记日志，不影响启动。 */
  async function warnIfSetupPending(): Promise<void> {
    try {
      if ((await new AccountsService(kernelDb(db)).countEnterpriseAdmins()) === 0) {
        log.warn("deployment is not set up; open the setup wizard or run `capybara admin create`");
      }
    } catch (e) {
      log.warn("cannot check whether the deployment is set up", { error: errMsg(e) });
    }
  }

  async function doStop(): Promise<void> {
    const deadline = Date.now() + STOP_TIMEOUT_MS;
    /** 在 `min(budgetMs, 总剩余)` 内等待 p；超时记 warn 并返回 false。 */
    const within = async (
      label: string,
      p: Promise<unknown>,
      budgetMs = Number.POSITIVE_INFINITY,
    ): Promise<boolean> => {
      let timer: NodeJS.Timeout | undefined;
      const waitMs = Math.max(0, Math.min(budgetMs, deadline - Date.now()));
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), waitMs);
        timer.unref();
      });
      try {
        const r = await Promise.race([p.then(() => "done" as const), timeout]);
        if (r === "timeout") log.warn("shutdown step timed out", { step: label });
        return r === "done";
      } catch (e) {
        log.error("shutdown step failed", { step: label, err: e });
        return false;
      } finally {
        clearTimeout(timer);
      }
    };

    // 不等待进行中的启动（插件 setup 可能任意慢）：中止进行中的内核迁移并等其会话结束；
    // 宿主关闭时中止插件迁移、立即关闭 setup 中的 ctx；其余启动步骤在 checkpoint 处退出。
    // 正在进行的 listen 要先等完，否则关闭会与监听交错留下端口。
    startAbort.abort();
    if (migratePromise)
      await within(
        "migrate",
        migratePromise.catch(() => {}),
        STOP_BUDGET_MS.migrate,
      );
    unwatch?.();
    unwatch = undefined;
    // http 阶段：等 listen 与关闭 HTTP 共用一个截止时间；listen 卡满预算时关闭只剩 0ms，直接强制断开
    const httpDeadline = Date.now() + STOP_BUDGET_MS.http;
    if (listenPromise) {
      await within(
        "listen",
        listenPromise.catch(() => {}),
        STOP_BUDGET_MS.http,
      );
    }
    if (!(await within("http", httpApp.close(), Math.max(0, httpDeadline - Date.now())))) {
      httpApp.closeAllConnections();
    }
    port = undefined;
    // runs 阶段：停止领取运行、让本进程的运行在步骤边界停下并回到队列；再关闭运行队列的生产方连接。
    const runsDeadline = Date.now() + STOP_BUDGET_MS.runs;
    if (runWorker) {
      const budget = Math.min(STOP_BUDGET_MS.runs, deadline - Date.now()) - RUNS_FORCE_CLOSE_MS;
      await within("runs", runWorker.close(Math.max(0, budget)), STOP_BUDGET_MS.runs);
    }
    await within("run-queue", runQueue.close(), Math.max(0, runsDeadline - Date.now()));
    await within("plugins", host.close(), STOP_BUDGET_MS.plugins);
    await within("bus", busSubscriber.close());
    if (redis.status === "ready") {
      if (!(await within("redis", redis.quit()))) redis.disconnect();
    } else {
      redis.disconnect();
    }
    await within("pg", db.destroy());
    log.info("kernel stopped");
  }

  const kernel: Kernel = {
    http: httpApp,
    host,
    orgPluginConfigs,
    bus,
    runs,
    log,
    get config() {
      return current;
    },
    get port() {
      return port;
    },
    async start() {
      if (started) throw new Error("kernel already started; start() may be called once");
      if (stopRequested) throw new Error("kernel is stopped");
      started = true;
      const checkpoint = () => {
        if (stopRequested) throw new Error("kernel stopped during start");
      };
      startPromise = (async () => {
        await redis.connect();
        checkpoint();
        await sql`select 1`.execute(db);
        checkpoint();
        migratePromise = migrate(
          config.db.url,
          { schema: KERNEL_SCHEMA, dir: KERNEL_MIGRATIONS_DIR },
          { connectTimeoutMs: config.db.connectTimeoutMs, signal: startAbort.signal },
        );
        await migratePromise;
        checkpoint();
        await host.load(config.plugins);
        checkpoint();
        if (config.roles.includes("worker")) {
          runWorker = new RunWorker({
            db: kdb,
            eventLog,
            lock,
            quota,
            abort,
            queue: runQueue,
            settings: new SettingsService(kdb, log),
            loop: loopFactory(stepDeps),
            config: () => current,
            log,
            redisUrl: config.redis.url,
            sinkFor,
            checkpoints,
            ...(opts.runHooks !== undefined && { hooks: opts.runHooks }),
          });
          runWorker.start();
        }
        httpApp.mountPlugins(host.routes());
        if (opts.source?.watch) {
          unwatch = opts.source.watch(onConfigChange, (err) =>
            log.error("config watch error", { error: err.message }),
          );
        }
        // 所有角色都监听：worker-only 时 HTTP 应用只有健康端点
        listenPromise = httpApp.listen(config.http.port);
        port = await listenPromise;
        checkpoint();
        log.info("kernel started", { roles: config.roles, port: kernel.port });
        await warnIfSetupPending();
      })();
      try {
        await startPromise;
      } catch (e) {
        if (!stopRequested) {
          log.error("kernel start failed", { err: e });
          await kernel.stop();
        }
        throw e;
      }
    },
    stop() {
      stopRequested = true;
      stopPromise ??= doStop();
      return stopPromise;
    },
  };
  return kernel;
}
