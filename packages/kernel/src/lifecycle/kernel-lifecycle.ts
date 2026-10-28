import { SANDBOX_EXTENSION_POINT, type SandboxProvider } from "@capybara-hq/plugin-sdk";
import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import type { Redis } from "ioredis";
import { type Kysely, sql } from "kysely";
import type { KernelAppOptions } from "../app.js";
import { CHANNEL_CHANGED_TOPIC } from "../channels/connections.service.js";
import type { ChannelSupervisor } from "../channels/supervisor.js";
import type { KernelConfig } from "../config/schema.js";
import { migrate } from "../db/migrator.js";
import type { EvalWorker } from "../evals/worker.js";
import {
  type BootstrapEntryResult,
  BootstrapFailedError,
  bootstrapManifestSha256,
  readBootstrapManifest,
} from "../extensions/bootstrap.js";
import { ExtensionHost } from "../extensions/host.js";
import { ensureMigrated } from "../extensions/migrate-lock.js";
import { syncPackage } from "../extensions/sync.js";
import type { KernelHttpApp } from "../http/app.js";
import type { GatewayRoutes } from "../http/gateway.module.js";
import { AccountsService } from "../identity/accounts.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KERNEL_LOGGER, KERNEL_POOL, REDIS } from "../infra/tokens.js";
import { KERNEL_MIGRATIONS_DIR, KERNEL_SCHEMA, type LegacyGraph } from "../kernel.js";
import type { KernelLogger } from "../log.js";
import type { RunWorker } from "../runtime/run-worker.js";
import { sandboxConfigWarnings } from "../sandbox/sandbox.service.js";
import { KERNEL_APP_OPTIONS, LEGACY_GRAPH } from "./tokens.js";

/** 优雅停机的总时限：超时后强制关闭剩余资源。 */
const STOP_TIMEOUT_MS = 30_000;

/**
 * 停机分阶段预算：每阶段实际等待 `min(阶段预算, 总剩余)`，按顺序为
 * migrate（中止进行中的内核迁移并等其会话结束）2s → http 10s → runs 10s → plugins 5s，合计 27s，
 * 余下 3s 给 bus / redis / pg 收尾（Redis 与连接池由 infra 模块在 onApplicationShutdown 里最后关闭）。
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

/** 停机时留给渠道长连接交还租约的最少时间（与 runs 阶段并行开始，runs 用尽预算时仍保底）。 */
const CHANNELS_STOP_MIN_MS = 2_000;

/** runs 阶段里留给强制关闭 worker 的余量（预算的其余部分用于等运行到达步骤边界）。 */
const RUNS_FORCE_CLOSE_MS = 500;

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The kernel's start order and stop phases on Nest's hooks (nest kernel spec §4).
 *
 * Start (`onApplicationBootstrap`, run by `app.init()`): Redis ready → kernel migrations → official
 * marketplace sync → bootstrap → extension host load → role parts (workers, schedules, gateway) →
 * mount extension routes → extension lifecycle reconcile → (second bootstrap pass) → config watch.
 * {@link listen} runs only after that resolved, so nothing is served before the extensions are
 * loaded. A stop requested meanwhile makes the sequence throw at its next checkpoint.
 *
 * Stop (`beforeApplicationShutdown`, or {@link stop} directly): readiness answers 503, the start is
 * aborted, then today's phases with {@link STOP_BUDGET_MS} (HTTP, runs, channels, queues, the
 * extension host). Redis and the pool are closed after this by the infra modules
 * (`onApplicationShutdown`, global modules run last).
 */
@Injectable()
export class KernelLifecycle
  implements OnApplicationBootstrap, BeforeApplicationShutdown, OnApplicationShutdown
{
  /** The startup config (hot fields are read through the config service). */
  private readonly config: KernelConfig;
  private stopRequested = false;
  /** Set when the application was never set up completely: shutdown only releases connections. */
  private onlyRelease = false;
  private stopPromise: Promise<void> | undefined;
  private readonly startAbort = new AbortController();
  /** The kernel migration in progress; the stop aborts it and waits for its session to end. */
  private migratePromise: Promise<unknown> | undefined;
  private listenPromise: Promise<number> | undefined;
  private listening: number | undefined;
  private httpApp: KernelHttpApp | undefined;
  private unwatchConfig: (() => void) | undefined;
  /** The channel supervisor's subscription to extension instance changes. */
  private unwatchPlugins: (() => void) | undefined;
  private unwatchWebhooks: (() => void) | undefined;
  private unsubscribeWebhooks: (() => Promise<void>) | undefined;
  private runWorker: RunWorker | undefined;
  private evalWorker: EvalWorker | undefined;
  private channelSupervisor: ChannelSupervisor | undefined;
  /** What the first bootstrap pass did, carried into the second one. */
  private bootstrapCarry: BootstrapEntryResult[] | undefined;

  constructor(
    @Inject(LEGACY_GRAPH) private readonly graph: LegacyGraph,
    @Inject(KernelConfigService) private readonly configService: KernelConfigService,
    @Inject(KERNEL_LOGGER) readonly log: KernelLogger,
    @Inject(KERNEL_APP_OPTIONS) private readonly options: KernelAppOptions,
    // biome-ignore lint/suspicious/noExplicitAny: the pool carries no schema types
    @Inject(KERNEL_POOL) private readonly pool: Kysely<any>,
    @Inject(REDIS) private readonly redis: Redis,
  ) {
    this.config = configService.get();
  }

  /** The kernel HTTP application (set up by `buildKernelApp` before `init()`). */
  get http(): KernelHttpApp {
    if (!this.httpApp) throw new Error("kernel HTTP application is not set up");
    return this.httpApp;
  }

  attachHttp(http: KernelHttpApp): void {
    this.httpApp = http;
  }

  /** The gateway role's HTTP routes (the channel webhook), when the roles include `gateway`. */
  gatewayRoutes(): GatewayRoutes | undefined {
    const webhooks = this.graph.channelWebhooks;
    return webhooks
      ? { webhooks, webhookMaxBodyBytes: this.config.channels.webhookMaxBodyBytes }
      : undefined;
  }

  /** The port listened on; undefined before {@link listen} resolves and after the stop. */
  get port(): number | undefined {
    return this.listening;
  }

  /** True from the moment a stop is requested (readiness answers 503). */
  isStopping(): boolean {
    return this.stopRequested;
  }

  /** The application was not set up completely: its shutdown only releases connections. */
  releaseOnly(): void {
    this.onlyRelease = true;
    this.stopRequested = true;
    this.startAbort.abort();
  }

  private checkpoint(): void {
    if (this.stopRequested) throw new Error("kernel stopped during start");
  }

  async onApplicationBootstrap(): Promise<void> {
    if (this.stopRequested) throw new Error("kernel is stopped");
    const { graph: g, config, options: opts } = this;
    const cfg = () => this.configService.get();
    await this.redis.connect();
    this.checkpoint();
    await sql`select 1`.execute(this.pool);
    this.checkpoint();
    this.migratePromise = migrate(
      config.db.url,
      { schema: KERNEL_SCHEMA, dir: KERNEL_MIGRATIONS_DIR },
      { connectTimeoutMs: config.db.connectTimeoutMs, signal: this.startAbort.signal },
    );
    await this.migratePromise;
    this.checkpoint();
    // official 清单来源按配置同步（幂等；每个副本启动时都做）
    await g.marketplaces.syncOfficialFromConfig();
    // The bootstrap plugins (spec §7), once per manifest across replicas (advisory lock)
    if (opts.bootstrap !== undefined) {
      g.setBootstrapDeclared(
        await ExtensionHost.declaredNames(config.extensions, {
          ...(opts.resolveFrom !== undefined && { resolveFrom: opts.resolveFrom }),
        }),
      );
    }
    const bootstrapAgain =
      opts.bootstrap !== undefined && (await this.runBootstrap(opts.bootstrap.dir));
    this.checkpoint();
    // 配置声明 → 安装记录（C15 / C13）。安装记录的包在本副本同步到 extensionHost.dir 后导入，
    // 与运行中的 reconcile 走同一条路径；迁移由一个副本持锁执行（ensureMigrated，C16）
    await g.host.load({
      config: config.extensions,
      installs: {
        desired: () => g.extensionInstalls.desired(),
        sync: (d) =>
          syncPackage(cfg().extensionHost.dir, d.name, d.sha256, g.extensionBlobs, {
            maxBytes: cfg().packages.maxBytes,
          }),
        migrate: async (d, dir, signal) =>
          d.migratedSha === d.sha256
            ? "migrated"
            : ensureMigrated(
                {
                  db: g.kdb,
                  dbUrl: config.db.url,
                  connectTimeoutMs: config.db.connectTimeoutMs,
                  bus: g.bus,
                  log: this.log,
                  // 宿主关闭时中止（运行中 reconcile 的迁移）；停机一开始就中止（启动加载中的迁移不等宿主关闭）
                  signal: AbortSignal.any([signal, this.startAbort.signal]),
                  timeoutMs: cfg().extensionHost.migrationTimeoutSeconds * 1000,
                },
                d.name,
                d.sha256,
                dir,
              ),
      },
    });
    this.checkpoint();
    const sandboxEntry = g.host
      .list("sandbox")
      .find((x) => x.capability === SANDBOX_EXTENSION_POINT);
    if (sandboxEntry !== undefined) {
      for (const w of sandboxConfigWarnings(
        cfg(),
        sandboxEntry.plugin,
        sandboxEntry.impl as SandboxProvider,
      )) {
        this.log[w.level](w.message);
      }
    }
    if (config.roles.includes("worker")) {
      this.runWorker = g.createRunWorker();
      this.runWorker.start();
      this.evalWorker = g.createEvalWorker();
      this.evalWorker.start();
      // 维护队列：周期任务的 scheduler（幂等，多副本重复登记无害）与唯一的 Worker。
      // 登记失败只记日志、不阻止启动（与 Worker 的连接错误同样处理）：任一 worker 副本下次启动时会再登记。
      try {
        await g.runs.maintenance.ensureSchedules();
      } catch (err) {
        this.log.error("cannot register maintenance job schedulers", { err });
      }
      this.checkpoint();
      g.runs.maintenance.startWorker();
      g.channels.outbound.startWorker();
      g.usageReport.startWorker();
      g.titles.startWorker();
      if (!config.roles.includes("gateway")) {
        this.log.info(
          "this process runs the worker role without gateway; channel long connections are held only by processes with the gateway role",
          { roles: config.roles },
        );
      }
    }
    if (config.roles.includes("gateway")) {
      const supervisor = g.createChannelSupervisor();
      this.channelSupervisor = supervisor;
      await supervisor.start();
      // 插件实例撤销 / 替换：交还它持有的长连接，按新实例重新选主（C17）
      this.unwatchPlugins = g.host.onChange((plugin) => supervisor.pluginChanged(plugin));
      this.checkpoint();
    }
    const webhooks = g.channelWebhooks;
    if (webhooks) {
      // The webhook runtime cache is read-through only: drop entries on every connection change
      // and whenever a plugin instance changes
      this.unsubscribeWebhooks = await g.bus.subscribe(CHANNEL_CHANGED_TOPIC, (payload) => {
        const id = (payload as { connectionId?: unknown } | null)?.connectionId;
        if (typeof id === "string") webhooks.invalidate(id);
      });
      this.unwatchWebhooks = g.host.onChange(() => webhooks.invalidateAll());
      this.checkpoint();
    }
    // Routes stay mounted and are resolved live: 503 extension.unavailable after an extension is revoked, back after it reloads (C17)
    this.http.mountPlugins(g.host.routeTable());
    // 订阅插件生命周期主题后补一次 reconcile（启动加载期间错过的消息，并写下第一轮心跳）
    await g.extensionLifecycle.start();
    this.checkpoint();
    await g.extensionLifecycle.reconcile("startup");
    this.checkpoint();
    if (bootstrapAgain && opts.bootstrap !== undefined) {
      await this.runBootstrap(opts.bootstrap.dir, true);
      this.checkpoint();
    }
    if (opts.source?.watch) {
      // 热更新：重新校验；只应用 hot 字段，其余变化 warn 并列出需重启的键；校验失败保持原配置
      this.unwatchConfig = opts.source.watch(
        (raw) => this.configService.apply(raw),
        (err) => this.log.error("config watch error", { error: err.message }),
      );
    }
  }

  /**
   * Listens on `port` (0.0.0.0; every role listens: worker-only serves only `/healthz` and
   * `/readyz`) after the start sequence; returns the actual port.
   */
  async listen(port: number): Promise<number> {
    this.listenPromise = this.http.listen(port);
    this.listening = await this.listenPromise;
    this.checkpoint();
    this.log.info("kernel started", { roles: this.config.roles, port: this.listening });
    await this.warnIfSetupPending();
    return this.listening;
  }

  /**
   * Runs the bootstrap step unless it is done for the manifest. A required entry that cannot be
   * completed (or a missing / tampered package: then nothing was installed) stops the start, so the
   * kernel never serves without a required plugin. A failed optional entry is logged and returns
   * true: the start runs the step once more after the extensions loaded (a declarative entry's
   * catalog files need the object store, which on a fresh deployment is itself a bootstrap plugin),
   * and the next start tries again while it stays incomplete.
   */
  private async runBootstrap(dir: string | undefined, final = false): Promise<boolean> {
    const manifest = this.options.bootstrapManifest ?? (await readBootstrapManifest());
    const bootstrap = this.graph.bootstrap;
    if (await bootstrap.isDone(bootstrapManifestSha256(manifest))) return false;
    try {
      // The second pass records what the first one did (not `kept` for what it installed)
      await bootstrap.run({
        manifest,
        ...(dir !== undefined && { dir }),
        signal: this.startAbort.signal,
        ...(this.bootstrapCarry !== undefined && { carry: this.bootstrapCarry }),
      });
      return false;
    } catch (e) {
      if (e instanceof BootstrapFailedError && !e.requiredFailed) {
        this.bootstrapCarry = e.results;
        if (final) {
          this.log.error(
            "bootstrap: optional plugins could not be installed; retried on the next start",
            { failures: e.failures },
          );
        } else {
          this.log.warn(
            "bootstrap: optional plugins could not be installed yet; retried once the extensions have loaded",
            { failures: e.failures },
          );
        }
        return true;
      }
      throw e;
    }
  }

  /** 部署尚无活跃企业管理员时提示去初始化；查询失败只记日志，不影响启动。 */
  private async warnIfSetupPending(): Promise<void> {
    try {
      if ((await new AccountsService(this.graph.kdb).countEnterpriseAdmins()) === 0) {
        this.log.warn(
          "deployment is not set up; open the setup wizard or run `capybara admin create`",
        );
      }
    } catch (e) {
      this.log.warn("cannot check whether the deployment is set up", { error: errMsg(e) });
    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  /** Logs the end of the stop phases (Redis and the pool close right after, in the infra modules). */
  onApplicationShutdown(): void {
    if (!this.onlyRelease) this.log.info("kernel stopped");
  }

  /**
   * Runs the stop phases once (idempotent): readiness answers 503 at once. Closing the application
   * calls this from `beforeApplicationShutdown`; the `createKernel` facade calls it first so the
   * flag flips synchronously.
   */
  stop(): Promise<void> {
    this.stopRequested = true;
    this.stopPromise ??= this.onlyRelease ? Promise.resolve() : this.runStopPhases();
    return this.stopPromise;
  }

  private async runStopPhases(): Promise<void> {
    const log = this.log;
    const g = this.graph;
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
    this.startAbort.abort();
    // 先中止进行中的插件请求（SSE 等长连接据 req.signal 收尾），否则它们会占满 http 阶段的预算
    this.httpApp?.abortPluginRequests();
    if (this.migratePromise) {
      await within(
        "migrate",
        this.migratePromise.catch(() => {}),
        STOP_BUDGET_MS.migrate,
      );
    }
    this.unwatchConfig?.();
    this.unwatchConfig = undefined;
    this.unwatchPlugins?.();
    this.unwatchWebhooks?.();
    await this.unsubscribeWebhooks?.().catch(() => {});
    // 不再接 reconcile（进行中的那次由宿主关闭收尾）
    await within("plugin-lifecycle", g.extensionLifecycle.stop(), 1_000);
    // http 阶段：等 listen 与关闭 HTTP 共用一个截止时间；listen 卡满预算时关闭只剩 0ms，直接强制断开
    const httpDeadline = Date.now() + STOP_BUDGET_MS.http;
    if (this.listenPromise) {
      await within(
        "listen",
        this.listenPromise.catch(() => {}),
        STOP_BUDGET_MS.http,
      );
    }
    const http = this.httpApp;
    if (http && !(await within("http", http.close(), Math.max(0, httpDeadline - Date.now())))) {
      http.closeAllConnections();
    }
    this.listening = undefined;
    // runs 阶段：停止领取运行、让本进程的运行在步骤边界停下并回到队列；再关闭运行队列的生产方连接。
    // 渠道长连接与之并行停止（中止 connect、释放租约），必须在插件关闭之前。
    const runsDeadline = Date.now() + STOP_BUDGET_MS.runs;
    const channelsStopped = this.channelSupervisor?.stop();
    if (this.runWorker) {
      const budget = Math.min(STOP_BUDGET_MS.runs, deadline - Date.now()) - RUNS_FORCE_CLOSE_MS;
      await within("runs", this.runWorker.close(Math.max(0, budget)), STOP_BUDGET_MS.runs);
    }
    if (this.evalWorker) {
      await within(
        "evals",
        this.evalWorker.close(Math.max(0, runsDeadline - Date.now() - RUNS_FORCE_CLOSE_MS)),
        Math.max(0, runsDeadline - Date.now()),
      );
    }
    if (channelsStopped) {
      // 至少留 2s 交还租约：否则其他副本要等租约过期（默认 30s）才能接管
      await within(
        "channels",
        channelsStopped,
        Math.max(CHANNELS_STOP_MIN_MS, runsDeadline - Date.now()),
      );
    }
    await within("maintenance", g.runs.maintenance.close(), Math.max(0, runsDeadline - Date.now()));
    // titles before usage.report: a finishing title call enqueues its usage report
    await within("titles", g.titles.stop(), Math.max(0, runsDeadline - Date.now()));
    // usage.report: in-flight deliveries are aborted and retried by any replica; before the plugins close
    await within("usage-report", g.usageReport.stop(), Math.max(0, runsDeadline - Date.now()));
    // 出站投递：进行中的任务交还队列（由其他副本从 last_seq 续投），必须在插件关闭之前
    await within(
      "channel-outbound",
      g.channels.outbound.close(),
      Math.max(CHANNELS_STOP_MIN_MS, runsDeadline - Date.now()),
    );
    await within("run-queue", g.runs.queue.close(), Math.max(0, runsDeadline - Date.now()));
    await within("eval-queue", g.evalQueue.close(), Math.max(0, runsDeadline - Date.now()));
    await within("plugins", g.host.close(), STOP_BUDGET_MS.plugins);
    // 删掉本副本的加载状态行（尽力而为；崩溃副本心跳过期的行由 reconcile 清理）
    await within("plugin-status", g.replicaStatus.removeAll(), 1_000);
  }
}
