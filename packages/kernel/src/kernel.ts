import { fileURLToPath } from "node:url";
import {
  type ExtensionContext,
  SANDBOX_EXTENSION_POINT,
  type SandboxProvider,
} from "@capybara-hq/plugin-sdk";
import type { INestApplication } from "@nestjs/common";
import type { Job } from "bullmq";
import type { Redis } from "ioredis";
import { buildKernelApp, closeKernelApp, type KernelAppOptions } from "./app.js";
import { CatalogService } from "./catalog/catalog.service.js";
import { MarketplacesService } from "./catalog/marketplaces.service.js";
import { PluginImport } from "./catalog/plugin-import.js";
import { ChannelConnections } from "./channels/connections.service.js";
import { ChannelInbound } from "./channels/inbound.js";
import { ChannelOutbound } from "./channels/outbound.js";
import type { KernelConfig } from "./config/schema.js";
import { AttachmentsService } from "./conversations/attachments.service.js";
import type { ConversationsService } from "./conversations/conversations.service.js";
import { EventLog } from "./conversations/event-log.js";
import { createKeyring } from "./ctx/secrets.js";
import type { KernelSchemaDb } from "./db/kernel-schema.js";
import { migrate } from "./db/migrator.js";
import type { EvalReplayHooks } from "./evals/run-replay.js";
import { EvalQueue } from "./evals/runs.service.js";
import { EvalWorker } from "./evals/worker.js";
import { ExtensionAdminOps } from "./extensions/admin-ops.js";
import { ExtensionAdmin } from "./extensions/admin-view.js";
import type { PendingExtension } from "./extensions/approvals.js";
import { ExtensionBlobs } from "./extensions/blobs.js";
import { BootstrapService } from "./extensions/bootstrap.js";
import { ExtensionDeploymentConfigService } from "./extensions/deployment-config.js";
import { ExtensionHost } from "./extensions/host.js";
import { ExtensionInstalls } from "./extensions/installs.js";
import { ExtensionLifecycle } from "./extensions/lifecycle.js";
import { OrgExtensionConfigs } from "./extensions/org-config.js";
import type { ExtensionRegistry } from "./extensions/registry.js";
import { ReplicaStatusStore } from "./extensions/sources.js";
import type { ApiDeps } from "./http/api.module.js";
import type { KernelHttp } from "./http/app.js";
import { IdentityBinding } from "./identity/binding.js";
import { ExternalIdentities } from "./identity/external.js";
import type { SettingsService } from "./identity/settings.js";
import { SsoFlow } from "./identity/sso.js";
import { KernelConfigService } from "./infra/config/kernel-config.service.js";
import type { KernelDb } from "./infra/database/kernel-db.js";
import { legacyKernelView } from "./infra/database/legacy-view.js";
import type { TransactionHost } from "./infra/database/transaction-host.js";
import type { KernelEvents } from "./infra/events/kernel-events.js";
import { GracefulShutdown } from "./infra/lifecycle/graceful-shutdown.service.js";
import { KernelLifecycle } from "./lifecycle/kernel-lifecycle.js";
import type { LegacyPorts } from "./lifecycle/legacy-ports.js";
import { KERNEL_TEST_HOOKS, LEGACY_GRAPH } from "./lifecycle/tokens.js";
import type { KernelLogger } from "./log.js";
import { PricesService } from "./models/prices.js";
import { ModelPurposesService } from "./models/purposes.js";
import { DIRECTORY_SYNC_JOB, DirectorySync, type SyncJobData } from "./orgs/directory-sync.js";
import { Offboarding } from "./orgs/offboarding.js";
import type { OrgLock } from "./orgs/org-lock.js";
import { RunAbort } from "./runtime/abort.js";
import type { KyselyCheckpointSaver } from "./runtime/checkpointer.js";
import { ConversationLock } from "./runtime/conversation-lock.js";
import type { LoopDeps } from "./runtime/langgraph-loop.js";
import { Maintenance } from "./runtime/maintenance.js";
import { ProviderRegistry } from "./runtime/providers.js";
import { type OrgQuota, RUN_QUOTA } from "./runtime/quota.js";
import type { RunFinish } from "./runtime/run-finish.js";
import { RunQueue } from "./runtime/run-queue.js";
import { type AgentLoops, RunSteps } from "./runtime/run-steps.js";
import { UsageReporter } from "./runtime/usage-report.js";
import { WAIT_TIMEOUT_JOB, Waits, type WaitTimeoutData } from "./runtime/waits.js";
import { registerSandboxMaintenance, scheduleSandboxDestroy } from "./sandbox/lifecycle.js";
import { SandboxService } from "./sandbox/sandbox.service.js";
import type { SkillsCatalogService } from "./skills/catalog.js";
import { SkillChangesService } from "./skills/changes.service.js";
import type { SkillInvoker } from "./skills/invoke.js";
import { SkillsService } from "./skills/skills.service.js";
import { StorageService } from "./storage/storage.service.js";
import { ApprovalsService } from "./tools/approvals.service.js";
import { ConnectorContent } from "./tools/connector-content.js";
import { Credentials } from "./tools/credentials.js";
import { type DriftConnectorJobData, ToolDrift } from "./tools/drift.js";
import { DRIFT_CONNECTOR_JOB } from "./tools/job-ids.js";
import { ToolOutputs } from "./tools/outputs.js";
import { ToolPipeline } from "./tools/pipeline.js";
import { QuestionsService } from "./tools/questions.service.js";
import { ToolRegistry } from "./tools/registry.js";

/**
 * 内核迁移目录。src/ 与 dist/ 都在包根下一层，所以统一指向 `<包根>/src/migrations`：
 * 用 tsx 从源码运行与运行 tsc 产物时解析到同一个目录（SQL 文件不进 dist，随包发布 src/migrations）。
 */
export const KERNEL_MIGRATIONS_DIR = fileURLToPath(new URL("../src/migrations/", import.meta.url));

/** 内核 PG schema。 */
export const KERNEL_SCHEMA = "capybara";

/** 运行编排相关的内核服务（后续任务的 loop / SSE 使用）。 */
export interface KernelRuns {
  readonly eventLog: EventLog;
  readonly registry: ProviderRegistry;
  readonly queue: RunQueue;
  readonly lock: ConversationLock;
  readonly quota: OrgQuota;
  readonly abort: RunAbort;
  /** 构造 loop 用的依赖（单步模型调用 + 工具执行管线）。 */
  readonly stepDeps: LoopDeps;
  /** 运行等待人处理：续跑、超时、等待中中止。 */
  readonly waits: Waits;
  /** 内核维护队列（等待超时、输出存档清理等）。 */
  readonly maintenance: Maintenance;
}

/** 工具相关的内核服务。 */
export interface KernelTools {
  readonly registry: ToolRegistry;
  readonly credentials: Credentials;
  /** 输出存档（超大工具结果）。 */
  readonly outputs: ToolOutputs;
  /** 工具执行管线（tools 节点使用）。 */
  readonly pipeline: ToolPipeline;
  /** 工具调用审批与「以后都允许」授权。 */
  readonly approvals: ApprovalsService;
  /** 工具调用的输入请求（回答后续跑）。 */
  readonly questions: QuestionsService;
  /** 工具定义漂移检测（周期扫描、list_changed、手动刷新）。 */
  readonly drift: ToolDrift;
  /** 连接器的 prompts / resources（斜杠命令、@ 资源引用与消息附件）。 */
  readonly connectorContent: ConnectorContent;
}

/** 外部身份相关的内核服务（渠道运行时、通讯录同步与 HTTP 共用）。 */
export interface KernelIdentity {
  /** 外部身份 ↔ 账号（登录、渠道入站、通讯录共用 `(source, externalId)` 键）。 */
  readonly external: ExternalIdentities;
  /** IM 身份的一次性绑定链接。 */
  readonly binding: IdentityBinding;
  /** 第三方登录（`identity-source@1`）。 */
  readonly sso: SsoFlow;
  /** 成员离职处理（移出、离开、通讯录同步共用）。 */
  readonly offboarding: Offboarding;
  /** 通讯录同步（`directory@1`：每小时扫描、手动、`directory_changed` 提示）。 */
  readonly directory: DirectorySync;
}

/** 渠道运行时（连接、入站、出站投递）。 */
export interface KernelChannels {
  /** 组织的渠道连接（CRUD、运行时配置、出站会话 `outbound` / `send`）。 */
  readonly connections: ChannelConnections;
  /** 出站投递与入站任务（队列 `cap-kernel-channels`；worker 角色消费）。 */
  readonly outbound: ChannelOutbound;
  /** 入站事件：`onEvent`（插件 `connect` 的回调，去重并入队）与 `handle`（worker 上处理入站任务）。 */
  readonly inbound: ChannelInbound;
}

/** 运行中的内核实例。 */
export interface Kernel {
  /**
   * The Nest application behind the facade: tests reach converted providers with
   * `k.app.get(Class)` (the form Phase 5 converts every test to).
   */
  readonly app: INestApplication;
  /** 内核 HTTP：进程内注入请求、列出路由。 */
  readonly http: KernelHttp;
  readonly host: ExtensionHost;
  /** usage.report delivery (fast path, sweeper and, on the worker role, the worker). */
  readonly usageReport: UsageReporter;
  /** This process's replica id (`<hostname>-<pid>-<6 random chars>`, written to `extension_replica_status`). */
  readonly replicaId: string;
  /** 插件包的导入（上传 / npm）与安装记录。 */
  readonly extensionInstalls: ExtensionInstalls;
  /** 部署级插件后台：列表、状态与网页批准权限。 */
  readonly extensionAdmin: ExtensionAdmin;
  /** 部署级插件的安装 / 启用 / 停用 / 卸载（只写期望状态并发布 `kernel.plugins.changed`）。 */
  readonly extensionAdminOps: ExtensionAdminOps;
  /** 本副本的插件生命周期：订阅 bus 并 reconcile 到 PG 期望状态（C16）。 */
  readonly extensionLifecycle: ExtensionLifecycle;
  /** 内容寻址的插件包存储（对象存储或 PG）。 */
  readonly extensionBlobs: ExtensionBlobs;
  /** The enterprise catalog: items and imports (plugins / connector templates / skills). */
  readonly catalog: CatalogService;
  /** Enterprise import of plugins (plugin tgz files): prepare / confirm and staging cleanup. */
  readonly pluginImport: PluginImport;
  /** The bootstrap step (package ecosystem spec §7); `start()` runs it when given `bootstrap`. */
  readonly bootstrap: BootstrapService;
  /** Marketplaces: official / enterprise marketplaces and their refresh. */
  readonly marketplaces: MarketplacesService;
  /** 部署级插件配置（PG，文件 / 环境变量里有的字段只读；C10）。 */
  readonly extensionDeploymentConfigs: ExtensionDeploymentConfigService;
  /** 组织级插件启用状态与配置（密钥字段加密存储）。 */
  readonly orgExtensionConfigs: OrgExtensionConfigs;
  /** 内核总线（命名空间 `kernel`）。 */
  readonly bus: ExtensionContext["bus"];
  /** 运行编排服务。 */
  readonly runs: KernelRuns;
  /** 工具注册表与连接器凭据。 */
  readonly tools: KernelTools;
  /** 外部身份、绑定、第三方登录与离职处理。 */
  readonly identity: KernelIdentity;
  /** 渠道连接与入站。 */
  readonly channels: KernelChannels;
  /**
   * 对象存储（`object-store@1` 提供方之上的前缀隔离，内核用 `kernel(orgId)`）；
   * 没有提供方时 `available` 为 false，各方法 reject `storage.unavailable`。
   */
  readonly storage: StorageService;
  /** 对话附件（上传、finalize、绑定、取字节、过期清理）。 */
  readonly attachments: AttachmentsService;
  /** 技能库（组织技能的上传、版本、列表与软删除）。 */
  readonly skills: SkillsService;
  /** agent 自写技能（`skill_write`）与共享 agent 的技能变更审批（R4）。 */
  readonly skillChanges: SkillChangesService;
  /** 模型价格表（PG `model_prices`，成本读时计算）。 */
  readonly prices: PricesService;
  /** 模型用途映射（部署默认 + 组织覆盖；评委用途 `eval`）。 */
  readonly purposes: ModelPurposesService;
  /**
   * 按对话的沙箱（`sandbox@1` 提供方之上：懒创建、锁、休眠与销毁）；
   * 没有提供方时 `available` 为 false，使用时抛 `sandbox.unavailable`（503）。
   */
  readonly sandbox: SandboxService;
  readonly log: KernelLogger;
  /** 当前生效的配置（热更新只替换 `hot` 字段）。 */
  readonly config: KernelConfig;
  /**
   * 实际监听的端口；尚未 start 或已 stop 时为 undefined。
   * 所有角色都监听：worker-only 只暴露 `/healthz` 与 `/readyz`（供 K8s 探针）。
   */
  readonly port: number | undefined;
  start(): Promise<void>;
  /** Graceful stop: idempotent, at most 30 s in all (the stop phases, then Redis and the pool). */
  stop(): Promise<void>;
}

/**
 * The test hooks of the legacy graph (ruling R2: provided as `KERNEL_TEST_HOOKS` until Task 3.9
 * converts the evals). The run loop and the run worker's hooks are provider overrides
 * (`AGENT_LOOP_FACTORY`, `RUN_HOOKS` in `overrides`).
 */
export interface KernelTestHooks {
  /** 评测整轮回放的测试钩子。 */
  evalHooks?: EvalReplayHooks;
}

/**
 * createKernel 的可选项：{@link KernelAppOptions}（含 `overrides`：测试替换的 provider，如
 * `AGENT_LOOP_FACTORY` / `RUN_HOOKS`）加上评测的测试钩子（临时 facade，见 `createKernel`）。
 */
export interface KernelOptions extends KernelAppOptions, KernelTestHooks {}

/**
 * 运行内核迁移与所有已配置插件的迁移（不调用插件 setup，不连接 Redis）。
 * 权限待批准的插件不迁移（`extensionPermissions.autoApprove` 时除外），经 `opts.onPending` 报告。
 */
export async function migrateAll(
  config: KernelConfig,
  opts: {
    resolveFrom?: string;
    onPending?: (pending: PendingExtension[]) => void;
  } = {},
): Promise<{ schema: string; plugin?: string; applied: string[] }[]> {
  const connectTimeoutMs = config.db.connectTimeoutMs;
  const kernel = await migrate(
    config.db.url,
    { schema: KERNEL_SCHEMA, dir: KERNEL_MIGRATIONS_DIR },
    { connectTimeoutMs },
  );
  const plugins = await ExtensionHost.migrateOnly(config.extensions, {
    dbUrl: config.db.url,
    connectTimeoutMs,
    autoApprove: config.extensionPermissions.autoApprove,
    ...(opts.resolveFrom !== undefined && { resolveFrom: opts.resolveFrom }),
    ...(opts.onPending !== undefined && { onPending: opts.onPending }),
  });
  return [{ schema: KERNEL_SCHEMA, applied: kernel.applied }, ...plugins];
}

/**
 * The legacy service graph: today's hand-wired kernel services, built by one factory provider
 * (`LEGACY_GRAPH`). Phase 3 of the nest kernel plan moves the domains out of it one directory at a
 * time (each becomes a module of injectable providers); `KernelLifecycle` drives what is left here.
 */
export interface LegacyGraph
  extends Omit<
    Kernel,
    | "app"
    | "http"
    | "port"
    | "start"
    | "stop"
    | "config"
    // converted to providers (Task 3.1); the facade reads them with app.get
    | "storage"
    | "skills"
    | "skillChanges"
    | "prices"
    | "purposes"
    // Task 3.2
    | "identity"
    // Task 3.3
    | "host"
    | "replicaId"
    | "extensionInstalls"
    | "extensionAdmin"
    | "extensionAdminOps"
    | "extensionLifecycle"
    | "extensionBlobs"
    | "bootstrap"
    | "extensionDeploymentConfigs"
    | "orgExtensionConfigs"
    // Task 3.4
    | "catalog"
    | "pluginImport"
    | "marketplaces"
    // Task 3.5
    | "tools"
    // Task 3.6a
    | "attachments"
    // Task 3.6b
    | "usageReport"
    | "runs"
    // Task 3.7
    | "channels"
  > {
  /** The kernel-schema view of the pool. */
  readonly kdb: KernelSchemaDb;
  readonly evalQueue: EvalQueue;
  /** The maintenance queue (its one worker until Task 3.9). */
  readonly maintenance: Maintenance;
  /** What the API module is built from (`ApiModule.registerFrom`). */
  readonly apiDeps: ApiDeps;
  /** The eval worker (worker role). */
  createEvalWorker(): EvalWorker;
}

/**
 * The converted providers the legacy graph consumes (Phase 3: each task adds its own and removes
 * their construction from the graph), plus the bridges of rulings R6–R8.
 */
export interface ConvertedProviders {
  txHost: TransactionHost;
  /** R6: the host writes it; converted providers read extension points from it. */
  extensionRegistry: ExtensionRegistry;
  /** R7: bound here with the legacy instances converted providers still need. */
  ports: LegacyPorts;
  storage: StorageService;
  prices: PricesService;
  purposes: ModelPurposesService;
  skills: SkillsService;
  skillChanges: SkillChangesService;
  skillsCatalog: SkillsCatalogService;
  skillInvoker: SkillInvoker;
  // Task 3.2
  settings: SettingsService;
  external: ExternalIdentities;
  binding: IdentityBinding;
  directory: DirectorySync;
  orgLock: OrgLock;
  /** In-process domain events: a decided approval / answered question resumes its run. */
  events: KernelEvents;
  // Task 3.3
  host: ExtensionHost;
  replicaStatus: ReplicaStatusStore;
  orgExtensionConfigs: OrgExtensionConfigs;
  // Task 3.5
  toolRegistry: ToolRegistry;
  approvals: ApprovalsService;
  questions: QuestionsService;
  toolDrift: ToolDrift;
  toolPipeline: ToolPipeline;
  // Task 3.6a
  eventLog: EventLog;
  conversationLock: ConversationLock;
  attachments: AttachmentsService;
  /** The one conversations service (ChannelInbound posts IM messages and skill invocations). */
  conversations: ConversationsService;
  // Task 3.6b
  registry: ProviderRegistry;
  waits: Waits;
  runFinish: RunFinish;
  checkpoints: KyselyCheckpointSaver;
  steps: RunSteps;
  loops: AgentLoops;
  evalQuota: OrgQuota;
}

/**
 * Builds the legacy service graph from the infra providers (one pool, one set of Redis clients:
 * those of `DatabaseModule` / `RedisModule`). Connects to nothing: the start sequence is
 * `KernelLifecycle`'s.
 */
export function createLegacyGraph(
  configService: KernelConfigService,
  log: KernelLogger,
  kernelDbHandle: KernelDb,
  redis: Redis,
  bus: ExtensionContext["bus"],
  hooks: KernelTestHooks,
  converted: ConvertedProviders,
): LegacyGraph {
  const { purposes, registry, waits, checkpoints, steps, loops } = converted;
  const config = configService.get();
  /** The current config (hot fields applied). */
  const cfg = (): KernelConfig => configService.get();
  const keyring = createKeyring(
    Buffer.from(config.masterKey, "base64"),
    config.masterKeyPrevious.map((k) => Buffer.from(k, "base64")),
  );
  const kdb = legacyKernelView(kernelDbHandle, converted.txHost);
  const { host, eventLog } = converted;
  const { toolDrift } = converted;
  // A decided approval / answered question resumes the waiting run on this replica (domain events,
  // spec §3b; the wait sweep resumes a run whose resume was lost). Its IM delivery follows the same
  // events (ChannelJobs).
  converted.events.on("approval.decided", async (a) => {
    await waits.resume(a.runId, a.id);
  });
  converted.events.on("question.answered", async (q) => {
    await waits.resume(q.runId, q.id);
  });
  const maintenance = new Maintenance({ db: kdb, redisUrl: config.redis.url, log });
  // wait-timeout jobs (Waits is their producer) stay on the maintenance worker until Task 3.9
  // builds its @Processor (R11)
  maintenance.handle(WAIT_TIMEOUT_JOB, (job, token) =>
    waits.processTimeout(job as Job<WaitTimeoutData>, token),
  );
  // 沙箱：提供方在 host.load() 之后才就绪，按调用时取；休眠与销毁由维护队列扫描
  const sandbox = new SandboxService({
    db: kdb,
    redis,
    provider: () => {
      const e = host.list("sandbox").find((x) => x.capability === SANDBOX_EXTENSION_POINT);
      return e ? { plugin: e.plugin, impl: e.impl as SandboxProvider } : undefined;
    },
    lookup: (plugin) =>
      host
        .list("sandbox")
        .find((x) => x.capability === SANDBOX_EXTENSION_POINT && x.plugin === plugin)?.impl as
        | SandboxProvider
        | undefined,
    config: cfg,
    log,
  });
  registerSandboxMaintenance(maintenance, sandbox, log);
  // drift-connector jobs (ToolDrift is their producer) stay on the maintenance worker until Task
  // 3.9 builds its @Processor (R11)
  maintenance.handle(DRIFT_CONNECTOR_JOB, async (job) => {
    const { orgId, connectorId, trigger } = job.data as DriftConnectorJobData;
    await toolDrift.check(orgId, connectorId, trigger);
  });
  // R7: the legacy instances converted providers read at call time
  converted.ports.bind({
    sandbox,
    // the departed member's sandboxes: one-off maintenance jobs, destroyed one by one by a worker
    sandboxDestroy: { destroy: (ids) => scheduleSandboxDestroy(maintenance, ids) },
  });
  // directory-sync jobs stay on the maintenance worker until Task 3.9 builds its @Processor (R11)
  maintenance.handle(DIRECTORY_SYNC_JOB, async (job) => {
    await converted.directory.runSyncJob(job.data as SyncJobData);
  });
  const stepDeps: LoopDeps = steps.deps;
  /** 评测队列（生产方：API 启动运行时入队）与 worker（含 worker 角色时启动）。 */
  const evalQueue = new EvalQueue(config.redis.url, log);
  const createEvalWorker = (): EvalWorker =>
    new EvalWorker({
      db: kdb,
      redisUrl: config.redis.url,
      quota: converted.evalQuota,
      config: cfg,
      log,
      purposes,
      // 媒体按快照自己的组织与对话、经组织范围的附件接口取（C3）
      replay: {
        registry,
        config: cfg,
        ...(stepDeps.media !== undefined && { media: stepDeps.media }),
      },
      // 整轮回放（C6）：同一个 loop 工厂（同一 LangGraphLoop），只换工具管线（RecordedToolPipeline，
      // 从不执行工具）、计费的模型注册表与按原对话取附件的来源
      runReplay: {
        db: kdb,
        eventLog,
        runFinish: converted.runFinish,
        config: cfg,
        log,
        registry,
        ...(stepDeps.media !== undefined && { media: stepDeps.media }),
        checkpoints,
        // explicitly without plugin hooks: eval replays never fire them (P-18); nor do they
        // publish sub-agent progress on a live conversation's stream
        loop: (d) => {
          // nor dispatch fork invocations: run-replay passes the recorded reports instead
          const {
            db: _snapshot,
            hooks: _noHooks,
            subagentProgress: _noProgress,
            skillForks: _noForks,
            ...replayDeps
          } = stepDeps;
          // the object rest above copied `db` as a value: read it through the step deps' getter
          // instead, so the loop always resolves the context-aware handle
          return loops.create({
            ...replayDeps,
            get db() {
              return stepDeps.db;
            },
            ...d,
          });
        },
        ...(hooks.evalHooks !== undefined && { hooks: hooks.evalHooks }),
      },
    });
  const apiDeps: ApiDeps = {
    db: kdb,
    keyring,
    config: cfg,
    log,
    evalQueue,
  };
  return {
    kdb,
    evalQueue,
    maintenance,
    apiDeps,
    createEvalWorker,
    bus,
    sandbox,
    log,
  };
}

/**
 * The temporary facade over {@link createKernelApp} (deleted in Phase 5 of the nest kernel plan):
 * builds the kernel application without starting it and returns today's {@link Kernel} fields.
 * `start()` initializes the application (the start sequence of `KernelLifecycle`) and listens;
 * `stop()` closes it (`closeKernelApp`: idempotent; the stop phases keep their budgets and, with
 * the infra closes, take at most 30 s).
 */
export async function createKernel(
  config: KernelConfig,
  opts: KernelOptions = {},
): Promise<Kernel> {
  const { evalHooks, overrides, ...appOptions } = opts;
  const hooks: KernelTestHooks = { ...(evalHooks !== undefined && { evalHooks }) };
  const app = await buildKernelApp(config, {
    ...appOptions,
    overrides: [...(overrides ?? []), { provide: KERNEL_TEST_HOOKS, useValue: hooks }],
  });
  const g = app.get<LegacyGraph>(LEGACY_GRAPH);
  const lifecycle = app.get(KernelLifecycle);
  const shutdown = app.get(GracefulShutdown);
  const configService = app.get(KernelConfigService);
  let started = false;

  const kernel: Kernel = {
    app,
    http: lifecycle.http,
    host: app.get(ExtensionHost),
    usageReport: app.get(UsageReporter),
    replicaId: app.get(ReplicaStatusStore).replicaId,
    extensionInstalls: app.get(ExtensionInstalls),
    extensionAdmin: app.get(ExtensionAdmin),
    extensionAdminOps: app.get(ExtensionAdminOps),
    extensionLifecycle: app.get(ExtensionLifecycle),
    extensionBlobs: app.get(ExtensionBlobs),
    catalog: app.get(CatalogService),
    pluginImport: app.get(PluginImport),
    bootstrap: app.get(BootstrapService),
    marketplaces: app.get(MarketplacesService),
    extensionDeploymentConfigs: app.get(ExtensionDeploymentConfigService),
    orgExtensionConfigs: app.get(OrgExtensionConfigs),
    bus: g.bus,
    runs: {
      eventLog: app.get(EventLog),
      registry: app.get(ProviderRegistry),
      queue: app.get(RunQueue),
      lock: app.get(ConversationLock),
      quota: app.get<OrgQuota>(RUN_QUOTA),
      abort: app.get(RunAbort),
      stepDeps: app.get(RunSteps).deps,
      waits: app.get(Waits),
      maintenance: g.maintenance,
    },
    tools: {
      registry: app.get(ToolRegistry),
      credentials: app.get(Credentials),
      outputs: app.get(ToolOutputs),
      pipeline: app.get(ToolPipeline),
      approvals: app.get(ApprovalsService),
      questions: app.get(QuestionsService),
      drift: app.get(ToolDrift),
      connectorContent: app.get(ConnectorContent),
    },
    identity: {
      external: app.get(ExternalIdentities),
      binding: app.get(IdentityBinding),
      sso: app.get(SsoFlow),
      offboarding: app.get(Offboarding),
      directory: app.get(DirectorySync),
    },
    channels: {
      connections: app.get(ChannelConnections),
      outbound: app.get(ChannelOutbound),
      inbound: app.get(ChannelInbound),
    },
    storage: app.get(StorageService),
    attachments: app.get(AttachmentsService),
    skills: app.get(SkillsService),
    skillChanges: app.get(SkillChangesService),
    prices: app.get(PricesService),
    purposes: app.get(ModelPurposesService),
    sandbox: g.sandbox,
    log: g.log,
    get config() {
      return configService.get();
    },
    get port() {
      return lifecycle.port;
    },
    async start() {
      if (started) throw new Error("kernel already started; start() may be called once");
      if (shutdown.isShuttingDown()) throw new Error("kernel is stopped");
      started = true;
      try {
        await app.init();
        await lifecycle.listen(config.http.port);
      } catch (e) {
        if (!shutdown.isShuttingDown()) {
          g.log.error("kernel start failed", { err: e });
          await kernel.stop();
        }
        throw e;
      }
    },
    stop() {
      return closeKernelApp(app);
    },
  };
  return kernel;
}
