import { fileURLToPath } from "node:url";
import {
  CHANNEL_EXTENSION_POINT,
  type Connector,
  DIRECTORY_EXTENSION_POINT,
  type ExtensionContext,
  OBJECT_STORE_EXTENSION_POINT,
  type ObjectStore,
  SANDBOX_EXTENSION_POINT,
  type SandboxProvider,
} from "@capybara-hq/plugin-sdk";
import type { Redis } from "ioredis";
import type { Kysely } from "kysely";
import { AgentsService } from "./agents/agents.service.js";
import { buildKernelApp, closeKernelApp, type KernelAppOptions } from "./app.js";
import { CatalogService } from "./catalog/catalog.service.js";
import { fetchMarketplaceArchive, marketplaceNetPolicy } from "./catalog/marketplace-fetch.js";
import {
  MARKETPLACES_REFRESH_DEADLINE_MS,
  MarketplacesService,
} from "./catalog/marketplaces.service.js";
import { PluginImport } from "./catalog/plugin-import.js";
import { ChannelConnections } from "./channels/connections.service.js";
import { ChannelInbound } from "./channels/inbound.js";
import { ChannelOutbound } from "./channels/outbound.js";
import {
  ChannelSupervisor,
  checkGatewayPresence,
  GATEWAY_CHECK_EVERY_MS,
  GATEWAY_CHECK_JOB,
  GATEWAY_CHECK_SCHEDULER_ID,
} from "./channels/supervisor.js";
import { ChannelWebhooks } from "./channels/webhook.js";
import type { KernelConfig } from "./config/schema.js";
import { configSourceKind, extensionConfigSources } from "./config/sources.js";
import {
  ATTACHMENT_CLEANUP_EVERY_MS,
  ATTACHMENT_CLEANUP_JOB,
  ATTACHMENT_CLEANUP_SCHEDULER_ID,
  AttachmentsService,
} from "./conversations/attachments.service.js";
import { ConversationsService } from "./conversations/conversations.service.js";
import {
  type ConversationBusMessage,
  conversationTopic,
  EventLog,
} from "./conversations/event-log.js";
import { TitleQueue } from "./conversations/titles.js";
import type { BusSubscriber } from "./ctx/bus.js";
import type { KernelDeps } from "./ctx/create-ctx.js";
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
import {
  ExtensionDeploymentConfigService,
  schemaFields,
  staticDeploymentSchema,
} from "./extensions/deployment-config.js";
import { ExtensionHost } from "./extensions/host.js";
import { ExtensionInstalls } from "./extensions/installs.js";
import {
  ExtensionLifecycle,
  PLUGINS_RECONCILE_JOB,
  PLUGINS_RECONCILE_SCHEDULER_ID,
  PLUGINS_RECONCILE_TOPIC,
  STALE_RECONCILE_PERIODS,
} from "./extensions/lifecycle.js";
import { OrgExtensionConfigs } from "./extensions/org-config.js";
import { newReplicaId, ReplicaStatusStore } from "./extensions/sources.js";
import type { ApiDeps } from "./http/api.module.js";
import type { KernelHttp } from "./http/app.js";
import { IdentityBinding } from "./identity/binding.js";
import { ExternalIdentities } from "./identity/external.js";
import { SessionService } from "./identity/sessions.js";
import { SettingsService } from "./identity/settings.js";
import { SsoFlow } from "./identity/sso.js";
import { KernelConfigService } from "./infra/config/kernel-config.service.js";
import type { KernelDb } from "./infra/database/kernel-db.js";
import { legacyKernelView } from "./infra/database/legacy-view.js";
import { GracefulShutdown } from "./infra/lifecycle/graceful-shutdown.service.js";
import { KernelLifecycle } from "./lifecycle/kernel-lifecycle.js";
import { KERNEL_TEST_HOOKS, LEGACY_GRAPH } from "./lifecycle/tokens.js";
import type { KernelLogger } from "./log.js";
import { PricesService } from "./models/prices.js";
import { ModelPurposesService } from "./models/purposes.js";
import { DirectorySync } from "./orgs/directory-sync.js";
import { Offboarding } from "./orgs/offboarding.js";
import { RunAbort } from "./runtime/abort.js";
import { KyselyCheckpointSaver } from "./runtime/checkpointer.js";
import { ConversationLock } from "./runtime/conversation-lock.js";
import { LangGraphLoop, type LoopDeps } from "./runtime/langgraph-loop.js";
import type { AgentLoop } from "./runtime/loop.js";
import {
  MARKETPLACES_REFRESH_JOB,
  MARKETPLACES_REFRESH_SCHEDULER_ID,
  Maintenance,
  PLUGIN_STAGING_CLEANUP_EVERY_MS,
  PLUGIN_STAGING_CLEANUP_JOB,
  PLUGIN_STAGING_CLEANUP_SCHEDULER_ID,
} from "./runtime/maintenance.js";
import type { StreamSink } from "./runtime/model-call.js";
import { ProviderRegistry } from "./runtime/providers.js";
import { EVAL_QUOTA_PREFIX, OrgQuota } from "./runtime/quota.js";
import { RunQueue } from "./runtime/run-queue.js";
import { type RunHooks, RunWorker } from "./runtime/run-worker.js";
import { onChildFinished, type StopChildrenDeps, stopChildren } from "./runtime/subagents/child.js";
import { dispatchSubagent } from "./runtime/subagents/dispatch.js";
import { publishSubagentProgress } from "./runtime/subagents/progress.js";
import { liveSkillForks } from "./runtime/subagents/skill-fork.js";
import {
  queryUnservable,
  queryUsageSubscribers,
  USAGE_SWEEP_EVERY_MS,
  USAGE_SWEEP_JOB,
  USAGE_SWEEP_SCHEDULER_ID,
  UsageReporter,
} from "./runtime/usage-report.js";
import { Waits } from "./runtime/waits.js";
import { registerSandboxMaintenance, scheduleSandboxDestroy } from "./sandbox/lifecycle.js";
import { SandboxService } from "./sandbox/sandbox.service.js";
import { SkillChangesService } from "./skills/changes.service.js";
import { SkillInvoker } from "./skills/invoke.js";
import { SkillsService } from "./skills/skills.service.js";
import {
  purgeDeletedOrgStorage,
  STORAGE_PURGE_EVERY_MS,
  STORAGE_PURGE_JOB,
  STORAGE_PURGE_SCHEDULER_ID,
} from "./storage/purge.js";
import { StorageService } from "./storage/storage.service.js";
import { ApprovalsService } from "./tools/approvals.service.js";
import { Breaker } from "./tools/breaker.js";
import { agentTool } from "./tools/builtins/agent.js";
import { askUserTool } from "./tools/builtins/ask-user.js";
import { readToolOutputTool } from "./tools/builtins/read-tool-output.js";
import { sandboxTools } from "./tools/builtins/sandbox/index.js";
import { skillLoadTool } from "./tools/builtins/skill-load.js";
import { skillWriteTool } from "./tools/builtins/skill-write.js";
import { toolSearchTool } from "./tools/builtins/tool-search.js";
import { ConnectorContent } from "./tools/connector-content.js";
import { Credentials } from "./tools/credentials.js";
import { ToolDrift } from "./tools/drift.js";
import { ToolOutputs } from "./tools/outputs.js";
import { ToolPipeline } from "./tools/pipeline.js";
import { QuestionsService } from "./tools/questions.service.js";
import { type BuiltinTool, ToolRegistry } from "./tools/registry.js";

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

/** The test hooks of the legacy graph (ruling R2: provided as `KERNEL_TEST_HOOKS` until Task 3.6). */
export interface KernelTestHooks {
  /**
   * 运行使用的 AgentLoop 工厂（测试用）。默认是 {@link LangGraphLoop}：checkpoint 存在内核的
   * `KyselyCheckpointSaver`，worker 崩溃后其他副本从 checkpoint 续跑。
   */
  loop?: (deps: LoopDeps) => AgentLoop;
  /** 运行 worker 的测试钩子。 */
  runHooks?: RunHooks;
  /** 评测整轮回放的测试钩子。 */
  evalHooks?: EvalReplayHooks;
}

/** createKernel 的可选项：{@link KernelAppOptions} 加上测试钩子（临时 facade，见 `createKernel`）。 */
export interface KernelOptions extends Omit<KernelAppOptions, "overrides">, KernelTestHooks {}

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
export interface LegacyGraph extends Omit<Kernel, "http" | "port" | "start" | "stop" | "config"> {
  /** The kernel-schema view of the pool. */
  readonly kdb: KernelSchemaDb;
  /** This replica's extension status rows. */
  readonly replicaStatus: ReplicaStatusStore;
  readonly evalQueue: EvalQueue;
  readonly titles: TitleQueue;
  /** Channel webhook inbound (gateway role only). */
  readonly channelWebhooks: ChannelWebhooks | undefined;
  /** What the API module is built from (`ApiModule.registerFrom`). */
  readonly apiDeps: ApiDeps;
  /** The config-declared extension names the bootstrap step must not install over. */
  setBootstrapDeclared(names: ReadonlySet<string>): void;
  /** The run worker (worker role). */
  createRunWorker(): RunWorker;
  /** The eval worker (worker role). */
  createEvalWorker(): EvalWorker;
  /** The channel long-connection supervisor (gateway role). */
  createChannelSupervisor(): ChannelSupervisor;
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
  busSubscriber: BusSubscriber,
  bus: ExtensionContext["bus"],
  opts: KernelAppOptions,
  hooks: KernelTestHooks,
): LegacyGraph {
  const config = configService.get();
  // The pool is for what needs a connection of its own (extension plugin schemas, LISTEN clients)
  const db = kernelDbHandle.pool;
  /** The current config (hot fields applied). */
  const cfg = (): KernelConfig => configService.get();
  const env = opts.env ?? process.env;
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
  const kdb = legacyKernelView(kernelDbHandle);
  const replicaId = newReplicaId();
  const replicaStatus = new ReplicaStatusStore(
    kdb,
    replicaId,
    config.http.replicaId === undefined ? undefined : String(config.http.replicaId),
    (text) => log.redact(text),
  );
  const host = new ExtensionHost(deps, config.extensionConfig, {
    ...(opts.resolveFrom !== undefined && { resolveFrom: opts.resolveFrom }),
    onSecrets: (v) => log.addSecrets(v),
    autoApprove: config.extensionPermissions.autoApprove,
    status: replicaStatus,
    drainMs: () => cfg().extensionHost.drainSeconds * 1000,
    disposeTimeoutMs: () => cfg().extensionHost.disposeTimeoutSeconds * 1000,
    reloadSetupTimeoutMs: () => cfg().extensionHost.reloadSetupTimeoutSeconds * 1000,
    hookTimeoutMs: () => cfg().hooks.timeoutMs,
    // Extensions the route gate treats as "known to the deployment": install records (any desired_state); extensionInstalls is created below and read at call time
    installedNames: async () => (await extensionInstalls.list()).map((r) => r.name),
    // 生效部署配置 = 启动配置补上 PG 里保存的字段（C10）；服务在下面创建，调用时才取
    deploymentConfig: (plugin, fileValue, schema) =>
      extensionDeploymentConfigs.effective(plugin, fileValue, schema),
  });
  const orgExtensionConfigs = new OrgExtensionConfigs(kdb, keyring, host, {
    onSecrets: (v) => log.addOrgSecrets(v),
    // 组织停用插件：该插件的渠道连接立即断开（扫描复核只是兜底）
    afterPut: async (orgId, plugin, enabled) => {
      if (!enabled) await channelConnections.notifyOrgChanged(orgId, plugin);
    },
    // 部署上停用的安装记录插件：组织页显示「不可用」，组织的启用开关不变（T14）
    installed: async () =>
      (await extensionInstalls.list()).map((r) => ({ name: r.name, version: r.version })),
  });
  // 每次日志推进后给有 IM 投递目标的会话排出站任务（任务追上后空闲即结束，之后的事件靠这里续上）
  const eventLog = new EventLog(kdb, bus, log, (conversationId) => enqueueOutbound(conversationId));
  const registry = new ProviderRegistry(host, redis, log);
  const credentials = new Credentials(kdb, keyring, log, { redis, config: cfg });
  const toolOutputs = new ToolOutputs(kdb, cfg);
  // 内置工具；tool_search 由注册表按组织设置与阈值自动加入（不进 agent 定义）。
  // 沙箱工具依赖下面才创建的存储、附件与沙箱服务，创建后追加进同一个数组（注册表每次调用时读它）。
  const builtins: BuiltinTool[] = [
    askUserTool({ config: cfg }),
    readToolOutputTool({ outputs: toolOutputs, config: cfg }),
    toolSearchTool(),
    // dispatches sub-agents; the tool pipeline handles its calls (sub-agents spec §4, §7.1)
    agentTool,
  ];
  const toolRegistry = new ToolRegistry({
    db: kdb,
    host,
    credentials,
    log,
    builtins,
    config: cfg,
  });
  // 审批决定 / 输入回答提交后续跑（waits 在下面创建；回调只在运行期间被调用）
  const approvals = new ApprovalsService({
    db: kdb,
    eventLog,
    config: cfg,
    log,
    onDecided: async (a) => {
      await waits.resume(a.runId, a.id);
      enqueueOutbound(a.conversationId);
    },
  });
  const questions = new QuestionsService({
    db: kdb,
    eventLog,
    config: cfg,
    log,
    onAnswered: async (q) => {
      await waits.resume(q.runId, q.id);
      enqueueOutbound(q.conversationId);
    },
  });
  const maintenance = new Maintenance({ db: kdb, redisUrl: config.redis.url, log });
  // 对象存储：提供方在 host.load() 之后才就绪，按调用时取
  const storage = new StorageService({
    provider: () =>
      host.list("object-store").find((e) => e.capability === OBJECT_STORE_EXTENSION_POINT)?.impl as
        | ObjectStore
        | undefined,
    // 可能存过数据的插件：已批准过权限的（含已卸载的）与当前加载的
    plugins: async () => {
      const rows = await kdb
        .selectFrom("extension_permission_snapshots")
        .select("plugin")
        .execute();
      return [...rows.map((r) => r.plugin), ...host.manifests().map((m) => m.name)];
    },
  });
  // 插件包：有对象存储放 deployment/plugins/blobs/，否则放 PG；安装记录与包的导入
  const extensionBlobs = new ExtensionBlobs({
    db: kdb,
    storage,
    maxBytes: () => cfg().packages.maxBytes,
  });
  const extensionInstalls = new ExtensionInstalls({
    db: kdb,
    blobs: extensionBlobs,
    config: cfg,
    declared: () => host.declared(),
  });
  const extensionAdmin = new ExtensionAdmin({
    db: kdb,
    blobs: extensionBlobs,
    installs: extensionInstalls,
    config: cfg,
    host,
    bus,
    log,
    // 批准后等本副本 reconcile 一次再返回视图（其他副本经 bus 收敛）
    reconcile: (reason) => extensionLifecycle.reconcile(reason),
  });
  // 插件生命周期（C16）：后台 / CLI 只写期望状态并发布 kernel.plugins.changed，各副本订阅后 reconcile；
  // 维护任务 plugins-reconcile 每 extensionHost.reconcileIntervalSeconds 秒发布 kernel.plugins.reconcile 兜底
  const extensionLifecycle = new ExtensionLifecycle({
    host,
    bus,
    status: replicaStatus,
    installedNames: async () => (await extensionInstalls.list()).map((r) => r.name),
    reconcileIntervalSeconds: () => cfg().extensionHost.reconcileIntervalSeconds,
    log,
  });
  const extensionAdminOps = new ExtensionAdminOps({
    db: kdb,
    view: (name) => extensionAdmin.get(name, { allowUnreadable: true }),
    declared: () => host.declared(),
    blobs: extensionBlobs,
    config: cfg,
    bus,
    reconcile: (reason) => extensionLifecycle.reconcile(reason),
    log,
  });
  const findConnector = (plugin: string, kind: string) =>
    host
      .list("connector")
      .find((e) => e.plugin === plugin && (e.impl as Connector | undefined)?.kind === kind)?.impl as
      | Connector
      | undefined;
  // Plugin import (spec §4.3): one review for every plugin; staged for 24 hours, the maintenance
  // job app-staging-cleanup removes expired staging every hour
  const pluginImport = new PluginImport({
    db: kdb,
    config: cfg,
    storage,
    installs: extensionInstalls,
    ops: extensionAdminOps,
    blobs: extensionBlobs,
    declared: () => host.declared(),
    findConnector,
    pluginVersion: (name) => host.manifests().find((m) => m.name === name)?.version,
    log,
  });
  /** Config-declared extension names, set by the start sequence before the bootstrap step. */
  let configDeclared: ReadonlySet<string> = new Set();
  const bootstrap = new BootstrapService({
    db: kdb,
    dbUrl: config.db.url,
    connectTimeoutMs: config.db.connectTimeoutMs,
    declared: () => configDeclared,
    config: cfg,
    imports: pluginImport,
    installs: extensionInstalls,
    ops: extensionAdminOps,
    log,
  });
  maintenance.handle(PLUGIN_STAGING_CLEANUP_JOB, async () => {
    const n = await pluginImport.cleanupExpired();
    if (n > 0) log.info("expired plugin imports cleaned up", { count: n });
  });
  maintenance.schedule({
    id: PLUGIN_STAGING_CLEANUP_SCHEDULER_ID,
    name: PLUGIN_STAGING_CLEANUP_JOB,
    everyMs: () => PLUGIN_STAGING_CLEANUP_EVERY_MS,
  });
  // Marketplaces (D16 / C26): official is synced from config at startup; the maintenance job
  // catalogs-refresh periodically refreshes every enabled marketplace
  const marketplaces = new MarketplacesService({ db: kdb, config: cfg, keyring, log });
  // Enterprise catalog (D9 / C21): every item is a plugin, imported through pluginImport;
  // extensionAdminOps installs an item's extension on the deployment
  const catalog = new CatalogService({
    db: kdb,
    config: cfg,
    installs: extensionInstalls,
    ops: extensionAdminOps,
    pluginImport,
    fetchArchive: (archive, signal) =>
      fetchMarketplaceArchive(archive, {
        maxBytes: cfg().packages.maxBytes,
        timeoutMs: 120_000,
        net: marketplaceNetPolicy(cfg()),
        ...(signal !== undefined && { signal }),
      }),
    marketplaceToken: (id) => marketplaces.token(id),
  });
  maintenance.handle(MARKETPLACES_REFRESH_JOB, async () => {
    await marketplaces.refreshAll(AbortSignal.timeout(MARKETPLACES_REFRESH_DEADLINE_MS));
  });
  maintenance.schedule({
    id: MARKETPLACES_REFRESH_SCHEDULER_ID,
    name: MARKETPLACES_REFRESH_JOB,
    everyMs: () => cfg().marketplaces.refreshIntervalMinutes * 60_000,
  });
  // 部署级插件配置（D8 / C10）：启动配置里有的字段只读；保存后发布 kernel.plugin-deployment-config，各副本重读
  const extensionDeploymentConfigs = new ExtensionDeploymentConfigService({
    db: kdb,
    keyring,
    fileConfig: () => cfg().extensionConfig,
    sources:
      opts.extensionConfigSources ??
      extensionConfigSources(
        { extensionConfig: config.extensionConfig },
        env,
        configSourceKind(env),
      ),
    schemaOf: async (plugin) => {
      const local = host.deploymentSchema(plugin);
      if (local) return { ...local, fields: schemaFields(local.schema) };
      // 与配置声明重名的安装记录不生效
      if (host.declared().has(plugin)) return undefined;
      return staticDeploymentSchema(kdb, plugin);
    },
    bus,
    applyLocal: (plugin) => extensionLifecycle.applyConfig(plugin),
    onSecrets: (v) => log.addSecrets(v),
    log,
  });
  maintenance.handle(PLUGINS_RECONCILE_JOB, async () => {
    await bus.publish(PLUGINS_RECONCILE_TOPIC, {});
  });
  maintenance.schedule({
    id: PLUGINS_RECONCILE_SCHEDULER_ID,
    name: PLUGINS_RECONCILE_JOB,
    everyMs: () => cfg().extensionHost.reconcileIntervalSeconds * 1000,
  });
  // 已删除组织的对象存储：软删除超过 storage.purgeDeletedOrgsAfterDays 天后由维护任务清理（每小时扫描）
  maintenance.handle(STORAGE_PURGE_JOB, async () => {
    await purgeDeletedOrgStorage({
      db: kdb,
      storage,
      afterDays: cfg().storage.purgeDeletedOrgsAfterDays,
      log,
    });
  });
  maintenance.schedule({
    id: STORAGE_PURGE_SCHEDULER_ID,
    name: STORAGE_PURGE_JOB,
    everyMs: () => STORAGE_PURGE_EVERY_MS,
  });
  // 对话附件：下载权限同会话流（只用 isAccessible，一条查询）；未绑定的过期附件由维护任务每小时清理
  // agent 自写技能（skill_write）与共享 agent 的技能变更审批（R4）
  const skillChanges = new SkillChangesService({ db: kdb, storage, eventLog, log });
  const conversationAccess = new ConversationsService(
    kdb,
    eventLog,
    new AgentsService(kdb, registry, toolRegistry, skillChanges),
  );
  const attachments = new AttachmentsService({
    db: kdb,
    storage,
    config: cfg,
    canAccessConversation: (orgId, id, viewer) =>
      conversationAccess.isAccessible(orgId, id, viewer),
    log,
  });
  const skills = new SkillsService({ db: kdb, storage, attachments });
  const prices = new PricesService(kdb);
  const purposes = new ModelPurposesService({
    db: kdb,
    registry,
    config: cfg,
    manifests: () => host.manifests(),
  });
  maintenance.handle(ATTACHMENT_CLEANUP_JOB, async () => {
    const n = await attachments.deleteExpired();
    if (n > 0) log.info("expired attachments deleted", { count: n });
  });
  maintenance.schedule({
    id: ATTACHMENT_CLEANUP_SCHEDULER_ID,
    name: ATTACHMENT_CLEANUP_JOB,
    everyMs: () => ATTACHMENT_CLEANUP_EVERY_MS,
  });
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
  builtins.push(
    ...sandboxTools({ sandbox, attachments, storage, eventLog, config: cfg }),
    // 技能加载：对话日志里有技能目录快照时由注册表自动加入（Ruling M17）
    skillLoadTool({ db: kdb, sandbox, attachments, storage, eventLog, config: cfg }),
    // 自写技能：agent 定义显式引用才可用
    skillWriteTool({ changes: skillChanges }),
  );
  // 漂移检测：登记周期扫描与检查任务（worker 角色执行）；手动刷新与 list_changed 也经它
  const toolDrift = new ToolDrift({
    db: kdb,
    registry: toolRegistry,
    credentials,
    config: cfg,
    log,
    maintenance,
  });
  const breaker = new Breaker(redis, cfg);
  // 用户直接使用连接器内容（斜杠命令 / @ 资源引用）
  const connectorContent = new ConnectorContent({
    db: kdb,
    registry: toolRegistry,
    credentials,
    breaker,
    config: cfg,
    log,
  });
  const toolPipeline = new ToolPipeline({
    db: kdb,
    eventLog,
    registry: toolRegistry,
    credentials,
    breaker,
    outputs: toolOutputs,
    approvals,
    questions,
    config: cfg,
    log,
    // plugin hooks (chat runs only; the eval replay uses RecordedToolPipeline, which has none)
    pluginHooks: host.hooks,
    // ToolResult.card: the extension's inline ui contributions (read live, no alias)
    inlineViews: (plugin) =>
      new Set(
        (host.current(plugin)?.manifest.ui ?? [])
          .filter((c) => c.place === "inline" && c.aliasOf === undefined)
          .map((c) => c.id),
      ),
    onToolsChanged: (orgId, connectorId) => {
      void toolDrift.onToolsChanged(orgId, connectorId);
    },
    // sub-agents (phase C): `agent` calls dispatch child runs onto their own queue
    subagents: {
      dispatch: (a) =>
        dispatchSubagent(
          {
            db: kdb,
            eventLog,
            purposes,
            registry,
            config: cfg,
            enqueue: (data, jobId, kind) => runQueue.enqueue(data, jobId, kind),
            log,
          },
          a,
        ),
    },
  });
  const tools: KernelTools = {
    registry: toolRegistry,
    credentials,
    outputs: toolOutputs,
    pipeline: toolPipeline,
    approvals,
    questions,
    drift: toolDrift,
    connectorContent,
  };
  const lock = new ConversationLock(redis, log);
  const quota = new OrgQuota(redis);
  const abort = new RunAbort(redis, bus);
  const checkpoints = new KyselyCheckpointSaver(kdb);
  const runQueue: RunQueue = new RunQueue(kdb, eventLog, lock, config.redis.url, log, checkpoints, {
    stopOpenCalls: (t, runId) => toolPipeline.stopOpenAgentCalls(t, runId),
    stopChildren: (runId) => stopChildren(childDeps(), runId, null),
  });
  // sub-agents (spec §7.3, §12): reporting a finished child to its parent and stopping children
  const childDeps = (): StopChildrenDeps => ({ db: kdb, eventLog, waits, runQueue, abort, log });
  const reportChild = (runId: string): Promise<void> =>
    onChildFinished(childDeps(), runId).catch((err) =>
      log.error("cannot report finished sub-agent run to its parent", { runId, err }),
    );
  /** `abortIfOrphaned`, then a stopped sub-agent reports to its parent at once. */
  const abortOrphan = async (c: string, runId: string, by: string | null): Promise<boolean> => {
    const r = await runQueue.abortIfOrphaned(c, runId, by);
    if (r) {
      await reportChild(runId);
      // a stopped parent stops its children (spec §12)
      await stopChildren(childDeps(), runId, null).catch((err) =>
        log.error("cannot stop the sub-agents of a run", { runId, err }),
      );
    }
    return r;
  };
  const waits: Waits = new Waits({
    db: kdb,
    eventLog,
    approvals,
    questions,
    runQueue,
    checkpoints,
    abortRequested: (runId) => abort.requested(runId),
    maintenance,
    log,
    subagents: {
      stop: (parentRunId, by, opts) => stopChildren(childDeps(), parentRunId, by, opts),
      finished: (childRunId) => onChildFinished(childDeps(), childRunId),
      stopOpenCalls: (t, runId) => toolPipeline.stopOpenAgentCalls(t, runId),
    },
  });
  const external = new ExternalIdentities(kdb, cfg);
  const offboarding = new Offboarding({
    credentials,
    approvals,
    questions,
    // Ruling A24：手动移出 / 离开时对该组织启用的每个通讯录插件写排除
    directoryPlugins: () =>
      host
        .list("directory")
        .filter((e) => e.capability === DIRECTORY_EXTENSION_POINT)
        .map((e) => e.plugin),
    // 只用来写吊销标记（Redis 快速路径）；会话签发仍在 HTTP 层
    sessions: new SessionService(kdb, redis, keyring, {
      accessTtlSeconds: config.auth.accessTokenTtlSeconds,
      refreshTtlDays: config.auth.refreshTokenTtlDays,
    }),
    eventLog,
    runs: {
      abortWaiting: async (c, runId, by) => {
        const r = await waits.abortWaiting(c, runId, by);
        enqueueOutbound(c);
        return r;
      },
      abortIfOrphaned: abortOrphan,
      requestAbort: (runId, by) => abort.request(runId, by),
    },
    db: kdb,
    redis,
    maintenance,
    log,
    // 离职者对话的沙箱：提交后投递维护任务，由 worker 逐个销毁（等正在跑的命令结束）
    sandboxes: { destroy: (ids) => scheduleSandboxDestroy(maintenance, ids) },
  });
  const identity: KernelIdentity = {
    external,
    binding: new IdentityBinding({ db: kdb, redis, config: cfg, external }),
    sso: new SsoFlow({ redis, config: cfg, host, external, log }),
    offboarding,
    // 通讯录同步：登记每小时扫描与同步任务（worker 角色执行）；手动与 directory_changed 也经它投递
    directory: new DirectorySync({
      db: kdb,
      redis,
      host,
      orgExtensionConfigs,
      external,
      offboarding,
      maintenance,
      log,
    }),
  };
  const runControl = {
    ensureRun: (id: string) => runQueue.ensureRun(id),
    abortIfOrphaned: (id: string, runId: string, by: string) => abortOrphan(id, runId, by),
    // 等待中被中止：审批 / 提问卡片变为已取消，排一个出站任务去更新
    abortWaiting: async (id: string, runId: string, by: string) => {
      const r = await waits.abortWaiting(id, runId, by);
      enqueueOutbound(id);
      return r;
    },
    requestAbort: (runId: string, by: string) => abort.request(runId, by),
  };
  const channelConnections = new ChannelConnections({
    db: kdb,
    keyring,
    host,
    bus,
    redis,
    log,
    onSecrets: (v) => log.addOrgSecrets(v),
    onResume: (id) => channelOutbound.resumeConnection(id),
    config: cfg,
  });
  const channelOutbound = new ChannelOutbound({
    db: kdb,
    redis,
    redisUrl: config.redis.url,
    bus,
    eventLog,
    connections: channelConnections,
    approvals,
    questions,
    config: cfg,
    log,
    // 入站任务（Ruling A21）在同一队列的 worker 上处理
    inbound: (id, e) => channels.inbound.handle(id, e),
  });
  /** 会话有 IM 投递目标时排一个出站任务（审批 / 回答 / 运行开始后）；失败只记日志。 */
  function enqueueOutbound(conversationId: string): void {
    channelOutbound
      .enqueue(conversationId)
      .catch((err) => log.warn("cannot enqueue channel delivery", { conversationId, err }));
  }
  const channels: KernelChannels = {
    connections: channelConnections,
    outbound: channelOutbound,
    inbound: new ChannelInbound({
      db: kdb,
      redis,
      connections: channelConnections,
      // phase D: `/name args` in IM goes through the same skill invocation as the web
      conversations: new ConversationsService(
        kdb,
        eventLog,
        new AgentsService(kdb, registry, toolRegistry, skillChanges),
        runControl,
        log,
        undefined,
        undefined,
        undefined,
        new SkillInvoker({ db: kdb, storage, log }),
      ),
      external,
      binding: identity.binding,
      directorySync: identity.directory,
      outbound: channelOutbound,
      queue: channelOutbound,
      approvals,
      questions,
      log,
    }),
  };
  /** Channel webhook inbound (gateway role only; F8 / F9). */
  const channelWebhooks = config.roles.includes("gateway")
    ? new ChannelWebhooks({ connections: channelConnections, inbound: channels.inbound, log })
    : undefined;
  // Warn (rate limited) when a channel plugin has holdable connections but no live gateway replica
  // with it loaded (R1 / R3); silent for one lease TTL after this process starts (first heartbeats)
  const gatewayCheckGraceFrom = Date.now();
  maintenance.handle(GATEWAY_CHECK_JOB, async () => {
    await checkGatewayPresence({
      db: kdb,
      redis,
      config: cfg,
      log,
      graceUntil: gatewayCheckGraceFrom + cfg().channels.leaseTtlMs,
    });
  });
  maintenance.schedule({
    id: GATEWAY_CHECK_SCHEDULER_ID,
    name: GATEWAY_CHECK_JOB,
    everyMs: () => GATEWAY_CHECK_EVERY_MS,
  });
  const loopFactory = hooks.loop ?? ((d: LoopDeps): AgentLoop => new LangGraphLoop(checkpoints, d));
  /**
   * 流式增量发布到会话频道（与 `{ kind: "events" }` 共用 `conv.<id>`），任意副本上的订阅方都能收到。
   * 发布失败只记日志：增量只是草稿，最终内容以日志中的 assistant_message 为准。
   */
  const sinkFor = (conversationId: string): StreamSink => {
    // 本次运行执行中推出的文本字符数（按步，step_reset 清零）：本进程正在执行的这次运行自己的计数
    let at = { runId: "", step: -1, chars: 0 };
    return (d) => {
      if (at.runId !== d.runId || at.step !== d.step || d.kind === "step_reset") {
        at = { runId: d.runId, step: d.step, chars: 0 };
      }
      const offset = at.chars;
      if (d.kind === "text") at.chars += d.text?.length ?? 0;
      const msg: ConversationBusMessage = {
        kind: "delta",
        runId: d.runId,
        step: d.step,
        delta: d.kind,
        ...(d.text !== undefined && { text: d.text }),
        ...(d.kind === "text" && { offset }),
      };
      bus
        .publish(conversationTopic(conversationId), msg)
        .catch((err) => log.warn("stream delta publish failed", { conversationId, err }));
    };
  };
  // usage.report metering: producer on every role, worker on the worker role (P-17)
  const usageReporter = new UsageReporter({
    db: kdb,
    redisUrl: config.redis.url,
    hooks: host.hooks,
    isActive: (plugin) => host.current(plugin) !== undefined,
    unservable: (plugins) =>
      queryUnservable(
        kdb,
        plugins,
        STALE_RECONCILE_PERIODS * cfg().extensionHost.reconcileIntervalSeconds,
      ),
    // deployment state (approved manifests in PG)
    subscribers: (orgId) => queryUsageSubscribers(kdb, orgId),
    config: cfg,
    log,
  });
  // Conversation titles (UI refresh B): enqueued after a completed run, worker on the worker role
  const titles = new TitleQueue({
    db: kdb,
    eventLog,
    purposes,
    usageReport: usageReporter,
    hooks: host.hooks,
    redisUrl: config.redis.url,
    config: cfg,
    log,
  });
  // R13 sweeper: re-enqueue recent usage events (once across replicas through the maintenance queue)
  maintenance.handle(USAGE_SWEEP_JOB, async () => {
    await usageReporter.sweep();
  });
  maintenance.schedule({
    id: USAGE_SWEEP_SCHEDULER_ID,
    name: USAGE_SWEEP_JOB,
    everyMs: () => USAGE_SWEEP_EVERY_MS,
  });
  const stepDeps: LoopDeps = {
    db: kdb,
    eventLog,
    registry,
    usageReport: usageReporter,
    tools: toolRegistry,
    config: cfg,
    log,
    toolPipeline,
    // plugin hooks for chat runs; the full-run replay below drops them (P-18)
    hooks: host.hooks,
    // a sub-agent's steps on its parent's stream (sub-agents spec §14.2)
    subagentProgress: (s) => publishSubagentProgress({ db: kdb, bus, log }, s),
    // phase D: a person's fork invocation dispatches its sub-agent in the run's first prepare
    skillForks: liveSkillForks({
      db: kdb,
      eventLog,
      purposes,
      registry,
      config: cfg,
      enqueue: (data, jobId, kind) => runQueue.enqueue(data, jobId, kind),
      log,
      invoker: new SkillInvoker({ db: kdb, storage, log }),
    }),
    media: {
      info: (orgId, conversationId, ids) => attachments.mediaInfo(orgId, conversationId, ids),
      fetch: (orgId, conversationId, ids, caps) =>
        attachments.fetchMedia(orgId, conversationId, ids, caps),
    },
  };
  const runs: KernelRuns = {
    eventLog,
    registry,
    queue: runQueue,
    lock,
    quota,
    abort,
    stepDeps,
    waits,
    maintenance,
  };
  /** 评测队列（生产方：API 启动运行时入队）与 worker（含 worker 角色时启动）。 */
  const evalQueue = new EvalQueue(config.redis.url, log);
  const createRunWorker = (): RunWorker =>
    new RunWorker({
      db: kdb,
      eventLog,
      lock,
      quota,
      abort,
      queue: runQueue,
      settings: new SettingsService(kdb, log),
      loop: loopFactory(stepDeps),
      config: cfg,
      log,
      redisUrl: config.redis.url,
      sinkFor,
      checkpoints,
      waits,
      onRunStart: enqueueOutbound,
      onRunCompleted: (conversationId) => void titles.maybeEnqueue(conversationId),
      models: registry,
      storage,
      onChildFinished: (runId) => onChildFinished(childDeps(), runId),
      stopChildren: (runId) => stopChildren(childDeps(), runId, null),
      stopOpenCalls: (t, runId) => toolPipeline.stopOpenAgentCalls(t, runId),
      ...(hooks.runHooks !== undefined && { hooks: hooks.runHooks }),
    });
  const createEvalWorker = (): EvalWorker =>
    new EvalWorker({
      db: kdb,
      redisUrl: config.redis.url,
      quota: new OrgQuota(redis, EVAL_QUOTA_PREFIX),
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
            hooks: _noHooks,
            subagentProgress: _noProgress,
            skillForks: _noForks,
            ...replayDeps
          } = stepDeps;
          return loopFactory({ ...replayDeps, ...d });
        },
        ...(hooks.evalHooks !== undefined && { hooks: hooks.evalHooks }),
      },
    });
  // Channel long-connection leader election: every gateway replica takes part, and only the
  // replica that holds a connection's lease connects it (E11-A)
  const createChannelSupervisor = (): ChannelSupervisor =>
    new ChannelSupervisor({
      db: kdb,
      redis,
      bus,
      connections: channelConnections,
      localPlugins: () =>
        host
          .list("channel")
          .filter((e) => e.capability === CHANNEL_EXTENSION_POINT)
          .map((e) => e.plugin),
      onEvent: (id, e) => channels.inbound.onEvent(id, e),
      config: cfg,
      log,
      replicaId,
    });
  const apiDeps: ApiDeps = {
    db: kdb,
    keyring,
    config: cfg,
    log,
    host,
    orgExtensionConfigs,
    eventLog,
    registry,
    credentials,
    toolRegistry,
    approvals,
    questions,
    drift: toolDrift,
    outputs: toolOutputs,
    connectorContent,
    identity,
    channels: channelConnections,
    runs: runControl,
    attachments,
    storage,
    sandbox,
    skills,
    skillChanges,
    prices,
    purposes,
    extensionInstalls,
    extensionAdmin,
    extensionAdminOps,
    extensionDeploymentConfigs,
    catalog,
    pluginImport,
    marketplaces,
    evalQueue,
    sandboxDestroy: { destroy: (ids) => scheduleSandboxDestroy(maintenance, ids) },
  };
  return {
    kdb,
    replicaStatus,
    evalQueue,
    titles,
    channelWebhooks,
    apiDeps,
    setBootstrapDeclared: (names) => {
      configDeclared = names;
    },
    createRunWorker,
    createEvalWorker,
    createChannelSupervisor,
    host,
    usageReport: usageReporter,
    replicaId,
    extensionInstalls,
    extensionAdmin,
    extensionAdminOps,
    extensionLifecycle,
    extensionBlobs,
    catalog,
    pluginImport,
    bootstrap,
    marketplaces,
    extensionDeploymentConfigs,
    orgExtensionConfigs,
    bus,
    runs,
    tools,
    identity,
    channels,
    storage,
    attachments,
    skills,
    skillChanges,
    prices,
    purposes,
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
  const { loop, runHooks, evalHooks, ...appOptions } = opts;
  const hooks: KernelTestHooks = {
    ...(loop !== undefined && { loop }),
    ...(runHooks !== undefined && { runHooks }),
    ...(evalHooks !== undefined && { evalHooks }),
  };
  const app = await buildKernelApp(config, {
    ...appOptions,
    overrides: [{ provide: KERNEL_TEST_HOOKS, useValue: hooks }],
  });
  const g = app.get<LegacyGraph>(LEGACY_GRAPH);
  const lifecycle = app.get(KernelLifecycle);
  const shutdown = app.get(GracefulShutdown);
  const configService = app.get(KernelConfigService);
  let started = false;

  const kernel: Kernel = {
    http: lifecycle.http,
    host: g.host,
    usageReport: g.usageReport,
    replicaId: g.replicaId,
    extensionInstalls: g.extensionInstalls,
    extensionAdmin: g.extensionAdmin,
    extensionAdminOps: g.extensionAdminOps,
    extensionLifecycle: g.extensionLifecycle,
    extensionBlobs: g.extensionBlobs,
    catalog: g.catalog,
    pluginImport: g.pluginImport,
    bootstrap: g.bootstrap,
    marketplaces: g.marketplaces,
    extensionDeploymentConfigs: g.extensionDeploymentConfigs,
    orgExtensionConfigs: g.orgExtensionConfigs,
    bus: g.bus,
    runs: g.runs,
    tools: g.tools,
    identity: g.identity,
    channels: g.channels,
    storage: g.storage,
    attachments: g.attachments,
    skills: g.skills,
    skillChanges: g.skillChanges,
    prices: g.prices,
    purposes: g.purposes,
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
