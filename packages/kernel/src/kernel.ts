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
import { Redis } from "ioredis";
import { sql } from "kysely";
import { AgentsService } from "./agents/agents.service.js";
import { CatalogService } from "./catalog/catalog.service.js";
import { fetchMarketplaceArchive } from "./catalog/marketplace-fetch.js";
import {
  MARKETPLACES_REFRESH_DEADLINE_MS,
  MarketplacesService,
} from "./catalog/marketplaces.service.js";
import { PluginImport } from "./catalog/plugin-import.js";
import { CHANNEL_CHANGED_TOPIC, ChannelConnections } from "./channels/connections.service.js";
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
import { changedPaths, configFields, getPath, secretValues, setPath } from "./config/fields.js";
import { type ConfigSource, resolveConfig } from "./config/load.js";
import { type KernelConfig, KernelConfigSchema } from "./config/schema.js";
import {
  type ConfigSourceKind,
  configSourceKind,
  extensionConfigSources,
} from "./config/sources.js";
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
import { createBus, createBusSubscriber } from "./ctx/bus.js";
import type { KernelDeps } from "./ctx/create-ctx.js";
import { createKeyring } from "./ctx/secrets.js";
import { kernelDb } from "./db/kernel-schema.js";
import { migrate } from "./db/migrator.js";
import { createDb } from "./db/pool.js";
import type { EvalReplayHooks } from "./evals/run-replay.js";
import { EvalQueue } from "./evals/runs.service.js";
import { EvalWorker } from "./evals/worker.js";
import { ExtensionAdminOps } from "./extensions/admin-ops.js";
import { ExtensionAdmin } from "./extensions/admin-view.js";
import type { PendingExtension } from "./extensions/approvals.js";
import { ExtensionBlobs } from "./extensions/blobs.js";
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
import { ensureMigrated } from "./extensions/migrate-lock.js";
import { OrgExtensionConfigs } from "./extensions/org-config.js";
import { newReplicaId, ReplicaStatusStore } from "./extensions/sources.js";
import { syncPackage } from "./extensions/sync.js";
import { ApiModule } from "./http/api.module.js";
import { createHttpApp, type KernelHttp, type KernelHttpApp } from "./http/app.js";
import { AccountsService } from "./identity/accounts.js";
import { IdentityBinding } from "./identity/binding.js";
import { ExternalIdentities } from "./identity/external.js";
import { SessionService } from "./identity/sessions.js";
import { SettingsService } from "./identity/settings.js";
import { SsoFlow } from "./identity/sso.js";
import { createLogger, type KernelLogger } from "./log.js";
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
import { SandboxService, sandboxConfigWarnings } from "./sandbox/sandbox.service.js";
import { SkillChangesService } from "./skills/changes.service.js";
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

/** 停机时留给渠道长连接交还租约的最少时间（与 runs 阶段并行开始，runs 用尽预算时仍保底）。 */
const CHANNELS_STOP_MIN_MS = 2_000;

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
  /** Enterprise import of plugins (app bundles, app.yaml): prepare / confirm and staging cleanup. */
  readonly pluginImport: PluginImport;
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
  loop?: (deps: LoopDeps) => AgentLoop;
  /** 运行 worker 的测试钩子。 */
  runHooks?: RunHooks;
  /** 评测整轮回放的测试钩子。 */
  evalHooks?: EvalReplayHooks;
  /**
   * 内置插件（C14）：由 CLI 传入（`openai-compatible`、`object-store-s3`），按模块解析（建议 `file:` URL），
   * 来源 `builtin`：预先批准、始终启用、不需组织启用；部署配置没配好时不加载（待配置），内核照常启动。
   * 与配置 `plugins` 列表重名时以内置为准并告警。
   */
  builtinExtensions?: string[];
  /**
   * Where each extension deployment config field of the startup config comes from (the
   * `extensionConfigSources` returned by `loadConfigWithSources`); these fields are read-only in the
   * admin console (D8). When omitted it is derived from `config.extensionConfig`: fields present in
   * the environment are `env`, the rest take the `CAPYBARA_CONFIG_SOURCE` kind (file / nacos).
   */
  extensionConfigSources?: Record<string, Record<string, ConfigSourceKind>>;
}

/**
 * 可热更新字段的应用函数：键为 schema 中标记 `hot` 的点路径。
 * 新增 hot 字段而漏写这里时 createKernel 直接抛错，避免「标了 hot 但从不生效」。
 */
const HOT_APPLIERS: Record<string, (k: { log: KernelLogger }, value: unknown) => void> = {
  "log.level": (k, v) => k.log.setLevel(String(v)),
  // 并发上限由运行时在每次取额度时经 `config()` 读取当前值，替换配置即生效，无需额外动作。
  "runtime.orgConcurrency": () => {},
  // 评测的组织并发同样在每次取额度时经 `config()` 读取当前值。
  "evals.orgConcurrency": () => {},
  // 登录方式与受信任的身份源在每次请求时经 `config()` 读取，替换配置即生效。
  "auth.loginSources": () => {},
  "auth.trustedIdentitySources": () => {},
  // The hook registry reads the time limit through `config()` on every run.
  "hooks.timeoutMs": () => {},
};

const HOT_PATHS = configFields(KernelConfigSchema)
  .filter((f) => f.meta?.hot)
  .map((f) => f.path);

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * 运行内核迁移与所有已配置插件的迁移（不调用插件 setup，不连接 Redis）。
 * 权限待批准的插件不迁移（`extensionPermissions.autoApprove` 时除外），经 `opts.onPending` 报告。
 */
export async function migrateAll(
  config: KernelConfig,
  opts: {
    resolveFrom?: string;
    onPending?: (pending: PendingExtension[]) => void;
    /** Builtin extensions (see {@link KernelOptions.builtinExtensions}): they skip the permission gate. */
    builtinExtensions?: string[];
    log?: { warn(msg: string, fields?: Record<string, unknown>): void };
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
    ...(opts.builtinExtensions !== undefined && { builtin: opts.builtinExtensions }),
    ...(opts.log !== undefined && { log: opts.log }),
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
  /** 渠道 supervisor 对插件注册表变化的订阅（停机时取消）。 */
  let unwatchPlugins: (() => void) | undefined;

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
  const replicaId = newReplicaId();
  const replicaStatus = new ReplicaStatusStore(
    kernelDb(db),
    replicaId,
    config.http.replicaId === undefined ? undefined : String(config.http.replicaId),
    (text) => log.redact(text),
  );
  const host = new ExtensionHost(deps, config.extensionConfig, {
    ...(opts.resolveFrom !== undefined && { resolveFrom: opts.resolveFrom }),
    onSecrets: (v) => log.addSecrets(v),
    autoApprove: config.extensionPermissions.autoApprove,
    status: replicaStatus,
    drainMs: () => current.extensionHost.drainSeconds * 1000,
    disposeTimeoutMs: () => current.extensionHost.disposeTimeoutSeconds * 1000,
    reloadSetupTimeoutMs: () => current.extensionHost.reloadSetupTimeoutSeconds * 1000,
    hookTimeoutMs: () => current.hooks.timeoutMs,
    // Extensions the route gate treats as "known to the deployment": install records (any desired_state); extensionInstalls is created below and read at call time
    installedNames: async () => (await extensionInstalls.list()).map((r) => r.name),
    // 生效部署配置 = 启动配置补上 PG 里保存的字段（C10）；服务在下面创建，调用时才取
    deploymentConfig: (plugin, fileValue, schema) =>
      extensionDeploymentConfigs.effective(plugin, fileValue, schema),
  });
  const orgExtensionConfigs = new OrgExtensionConfigs(kernelDb(db), keyring, host, {
    onSecrets: (v) => log.addOrgSecrets(v),
    // 组织停用插件：该插件的渠道连接立即断开（扫描复核只是兜底）
    afterPut: async (orgId, plugin, enabled) => {
      if (!enabled) await channelConnections.notifyOrgChanged(orgId, plugin);
    },
    // 部署上停用的安装记录插件：组织页显示「不可用」，组织的启用开关不变（T14）
    installed: async () =>
      (await extensionInstalls.list()).map((r) => ({ name: r.name, version: r.version })),
  });
  const servePlugins = config.roles.includes("api") || config.roles.includes("gateway");
  const kdb = kernelDb(db);
  const bus = createBus(redis, busSubscriber, "kernel", log);
  // 每次日志推进后给有 IM 投递目标的会话排出站任务（任务追上后空闲即结束，之后的事件靠这里续上）
  const eventLog = new EventLog(kdb, bus, log, (conversationId) => enqueueOutbound(conversationId));
  const registry = new ProviderRegistry(host, redis, log);
  const credentials = new Credentials(kdb, keyring, log, { redis, config: () => current });
  const toolOutputs = new ToolOutputs(kdb, () => current);
  // 内置工具；tool_search 由注册表按组织设置与阈值自动加入（不进 agent 定义）。
  // 沙箱工具依赖下面才创建的存储、附件与沙箱服务，创建后追加进同一个数组（注册表每次调用时读它）。
  const builtins: BuiltinTool[] = [
    askUserTool({ config: () => current }),
    readToolOutputTool({ outputs: toolOutputs, config: () => current }),
    toolSearchTool(),
  ];
  const toolRegistry = new ToolRegistry({
    db: kdb,
    host,
    credentials,
    log,
    builtins,
    config: () => current,
  });
  // 审批决定 / 输入回答提交后续跑（waits 在下面创建；回调只在运行期间被调用）
  const approvals = new ApprovalsService({
    db: kdb,
    eventLog,
    config: () => current,
    log,
    onDecided: async (a) => {
      await waits.resume(a.runId, a.id);
      enqueueOutbound(a.conversationId);
    },
  });
  const questions = new QuestionsService({
    db: kdb,
    eventLog,
    config: () => current,
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
    maxBytes: () => current.packages.maxBytes,
  });
  const extensionInstalls = new ExtensionInstalls({
    db: kdb,
    blobs: extensionBlobs,
    config: () => current,
    declared: () => host.declared(),
  });
  const extensionAdmin = new ExtensionAdmin({
    db: kdb,
    blobs: extensionBlobs,
    installs: extensionInstalls,
    config: () => current,
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
    reconcileIntervalSeconds: () => current.extensionHost.reconcileIntervalSeconds,
    log,
  });
  const extensionAdminOps = new ExtensionAdminOps({
    db: kdb,
    view: (name) => extensionAdmin.get(name, { allowUnreadable: true }),
    declared: () => host.declared(),
    blobs: extensionBlobs,
    config: () => current,
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
    config: () => current,
    storage,
    installs: extensionInstalls,
    ops: extensionAdminOps,
    blobs: extensionBlobs,
    declared: () => host.declared(),
    findConnector,
    pluginVersion: (name) => host.manifests().find((m) => m.name === name)?.version,
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
  // Enterprise catalog (D9 / C21): every item is a plugin, imported through pluginImport;
  // extensionAdminOps installs an item's extension on the deployment
  const catalog = new CatalogService({
    db: kdb,
    config: () => current,
    installs: extensionInstalls,
    ops: extensionAdminOps,
    pluginImport,
    fetchArchive: (archive, signal) =>
      fetchMarketplaceArchive(archive, {
        maxBytes: current.packages.maxBytes,
        timeoutMs: 120_000,
        allowInsecureLoopback: current.marketplaces.allowInsecureLoopback,
        ...(signal !== undefined && { signal }),
      }),
  });
  // Marketplaces (D16 / C26): official is synced from config at startup; the maintenance job
  // catalogs-refresh periodically refreshes every enabled marketplace
  const marketplaces = new MarketplacesService({ db: kdb, config: () => current, keyring, log });
  maintenance.handle(MARKETPLACES_REFRESH_JOB, async () => {
    await marketplaces.refreshAll(AbortSignal.timeout(MARKETPLACES_REFRESH_DEADLINE_MS));
  });
  maintenance.schedule({
    id: MARKETPLACES_REFRESH_SCHEDULER_ID,
    name: MARKETPLACES_REFRESH_JOB,
    everyMs: () => current.marketplaces.refreshIntervalMinutes * 60_000,
  });
  // 部署级插件配置（D8 / C10）：启动配置里有的字段只读；保存后发布 kernel.plugin-deployment-config，各副本重读
  const extensionDeploymentConfigs = new ExtensionDeploymentConfigService({
    db: kdb,
    keyring,
    fileConfig: () => current.extensionConfig,
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
      // 与内置 / 配置声明重名的安装记录不生效
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
    everyMs: () => current.extensionHost.reconcileIntervalSeconds * 1000,
  });
  // 已删除组织的对象存储：软删除超过 storage.purgeDeletedOrgsAfterDays 天后由维护任务清理（每小时扫描）
  maintenance.handle(STORAGE_PURGE_JOB, async () => {
    await purgeDeletedOrgStorage({
      db: kdb,
      storage,
      afterDays: current.storage.purgeDeletedOrgsAfterDays,
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
    config: () => current,
    canAccessConversation: (orgId, id, viewer) =>
      conversationAccess.isAccessible(orgId, id, viewer),
    log,
  });
  const skills = new SkillsService({ db: kdb, storage, attachments });
  const prices = new PricesService(kdb);
  const purposes = new ModelPurposesService({
    db: kdb,
    registry,
    config: () => current,
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
    config: () => current,
    log,
  });
  registerSandboxMaintenance(maintenance, sandbox, log);
  builtins.push(
    ...sandboxTools({ sandbox, attachments, storage, eventLog, config: () => current }),
    // 技能加载：对话日志里有技能目录快照时由注册表自动加入（Ruling M17）
    skillLoadTool({ db: kdb, sandbox, attachments, storage, eventLog, config: () => current }),
    // 自写技能：agent 定义显式引用才可用
    skillWriteTool({ changes: skillChanges }),
  );
  // 漂移检测：登记周期扫描与检查任务（worker 角色执行）；手动刷新与 list_changed 也经它
  const toolDrift = new ToolDrift({
    db: kdb,
    registry: toolRegistry,
    credentials,
    config: () => current,
    log,
    maintenance,
  });
  const breaker = new Breaker(redis, () => current);
  // 用户直接使用连接器内容（斜杠命令 / @ 资源引用）
  const connectorContent = new ConnectorContent({
    db: kdb,
    registry: toolRegistry,
    credentials,
    breaker,
    config: () => current,
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
    config: () => current,
    log,
    // plugin hooks (chat runs only; the eval replay uses RecordedToolPipeline, which has none)
    pluginHooks: host.hooks,
    onToolsChanged: (orgId, connectorId) => {
      void toolDrift.onToolsChanged(orgId, connectorId);
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
  const runQueue = new RunQueue(kdb, eventLog, lock, config.redis.url, log, checkpoints);
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
  });
  const external = new ExternalIdentities(kdb, () => current);
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
      abortIfOrphaned: (c, runId, by) => runQueue.abortIfOrphaned(c, runId, by),
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
    binding: new IdentityBinding({ db: kdb, redis, config: () => current, external }),
    sso: new SsoFlow({ redis, config: () => current, host, external, log }),
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
    abortIfOrphaned: (id: string, runId: string, by: string) =>
      runQueue.abortIfOrphaned(id, runId, by),
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
    config: () => current,
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
    config: () => current,
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
      conversations: new ConversationsService(
        kdb,
        eventLog,
        new AgentsService(kdb, registry, toolRegistry, skillChanges),
        runControl,
        log,
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
  let channelSupervisor: ChannelSupervisor | undefined;
  /** Channel webhook inbound (gateway role only; F8 / F9). */
  const channelWebhooks = config.roles.includes("gateway")
    ? new ChannelWebhooks({ connections: channelConnections, inbound: channels.inbound, log })
    : undefined;
  let unwatchWebhooks: (() => void) | undefined;
  let unsubscribeWebhooks: (() => Promise<void>) | undefined;
  // Warn (rate limited) when a channel plugin has holdable connections but no live gateway replica
  // with it loaded (R1 / R3); silent for one lease TTL after this process starts (first heartbeats)
  const gatewayCheckGraceFrom = Date.now();
  maintenance.handle(GATEWAY_CHECK_JOB, async () => {
    await checkGatewayPresence({
      db: kdb,
      redis,
      config: () => current,
      log,
      graceUntil: gatewayCheckGraceFrom + current.channels.leaseTtlMs,
    });
  });
  maintenance.schedule({
    id: GATEWAY_CHECK_SCHEDULER_ID,
    name: GATEWAY_CHECK_JOB,
    everyMs: () => GATEWAY_CHECK_EVERY_MS,
  });
  const loopFactory = opts.loop ?? ((d: LoopDeps): AgentLoop => new LangGraphLoop(checkpoints, d));
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
        STALE_RECONCILE_PERIODS * current.extensionHost.reconcileIntervalSeconds,
      ),
    // deployment state (approved manifests in PG) plus builtin plugins (no snapshot, always enabled)
    subscribers: async (orgId) => {
      const subs = await queryUsageSubscribers(kdb, orgId);
      for (const m of host.manifests()) {
        if (host.sourceOf(m.name) === "builtin" && m.permissions?.hooks?.includes("usage.report")) {
          subs.add(m.name);
        }
      }
      return subs;
    },
    config: () => current,
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
    config: () => current,
    log,
    toolPipeline,
    // plugin hooks for chat runs; the full-run replay below drops them (P-18)
    hooks: host.hooks,
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
  let runWorker: RunWorker | undefined;
  /** 评测队列（生产方：API 启动运行时入队）与 worker（含 worker 角色时启动）。 */
  const evalQueue = new EvalQueue(config.redis.url, log);
  let evalWorker: EvalWorker | undefined;
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
      ...(channelWebhooks && {
        gateway: {
          webhooks: channelWebhooks,
          webhookMaxBodyBytes: config.channels.webhookMaxBodyBytes,
        },
      }),
      apiModule: ApiModule.register({
        db: kdb,
        redis,
        keyring,
        config: () => current,
        log,
        host,
        orgExtensionConfigs,
        bus,
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
      }),
      trustProxy: config.http.trustProxy,
      replicaId: config.http.replicaId === undefined ? undefined : String(config.http.replicaId),
      packageMaxBytes: config.packages.maxBytes,
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
    // 先中止进行中的插件请求（SSE 等长连接据 req.signal 收尾），否则它们会占满 http 阶段的预算
    httpApp.abortPluginRequests();
    if (migratePromise)
      await within(
        "migrate",
        migratePromise.catch(() => {}),
        STOP_BUDGET_MS.migrate,
      );
    unwatch?.();
    unwatchPlugins?.();
    unwatchWebhooks?.();
    await unsubscribeWebhooks?.().catch(() => {});
    // 不再接 reconcile（进行中的那次由宿主关闭收尾）
    await within("plugin-lifecycle", extensionLifecycle.stop(), 1_000);
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
    // 渠道长连接与之并行停止（中止 connect、释放租约），必须在插件关闭之前。
    const runsDeadline = Date.now() + STOP_BUDGET_MS.runs;
    const channelsStopped = channelSupervisor?.stop();
    if (runWorker) {
      const budget = Math.min(STOP_BUDGET_MS.runs, deadline - Date.now()) - RUNS_FORCE_CLOSE_MS;
      await within("runs", runWorker.close(Math.max(0, budget)), STOP_BUDGET_MS.runs);
    }
    if (evalWorker) {
      await within(
        "evals",
        evalWorker.close(Math.max(0, runsDeadline - Date.now() - RUNS_FORCE_CLOSE_MS)),
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
    await within("maintenance", maintenance.close(), Math.max(0, runsDeadline - Date.now()));
    // usage.report: in-flight deliveries are aborted and retried by any replica; before the plugins close
    await within("usage-report", usageReporter.stop(), Math.max(0, runsDeadline - Date.now()));
    // 出站投递：进行中的任务交还队列（由其他副本从 last_seq 续投），必须在插件关闭之前
    await within(
      "channel-outbound",
      channelOutbound.close(),
      Math.max(CHANNELS_STOP_MIN_MS, runsDeadline - Date.now()),
    );
    await within("run-queue", runQueue.close(), Math.max(0, runsDeadline - Date.now()));
    await within("eval-queue", evalQueue.close(), Math.max(0, runsDeadline - Date.now()));
    await within("plugins", host.close(), STOP_BUDGET_MS.plugins);
    // 删掉本副本的加载状态行（尽力而为；崩溃副本心跳过期的行由 reconcile 清理）
    await within("plugin-status", replicaStatus.removeAll(), 1_000);
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
    usageReport: usageReporter,
    replicaId,
    extensionInstalls,
    extensionAdmin,
    extensionAdminOps,
    extensionLifecycle,
    extensionBlobs,
    catalog,
    pluginImport,
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
        // official 清单来源按配置同步（幂等；每个副本启动时都做）
        await marketplaces.syncOfficialFromConfig();
        // 内置 → 配置声明 → 安装记录（C14 / C15 / C13）。安装记录的包在本副本同步到 extensionHost.dir 后导入，
        // 与运行中的 reconcile 走同一条路径；迁移由一个副本持锁执行（ensureMigrated，C16）
        await host.load({
          builtin: opts.builtinExtensions ?? [],
          config: config.extensions,
          installs: {
            desired: () => extensionInstalls.desired(),
            sync: (d) =>
              syncPackage(current.extensionHost.dir, d.name, d.sha256, extensionBlobs, {
                maxBytes: current.packages.maxBytes,
              }),
            migrate: async (d, dir, signal) =>
              d.migratedSha === d.sha256
                ? "migrated"
                : ensureMigrated(
                    {
                      db: kdb,
                      dbUrl: config.db.url,
                      connectTimeoutMs: config.db.connectTimeoutMs,
                      bus,
                      log,
                      // 宿主关闭时中止（运行中 reconcile 的迁移）；停机一开始就中止（启动加载中的迁移不等宿主关闭）
                      signal: AbortSignal.any([signal, startAbort.signal]),
                      timeoutMs: current.extensionHost.migrationTimeoutSeconds * 1000,
                    },
                    d.name,
                    d.sha256,
                    dir,
                  ),
          },
        });
        checkpoint();
        const sandboxPlugin = host
          .list("sandbox")
          .find((x) => x.capability === SANDBOX_EXTENSION_POINT)?.plugin;
        if (sandboxPlugin !== undefined) {
          for (const w of sandboxConfigWarnings(current, sandboxPlugin)) log[w.level](w.message);
        }
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
            waits,
            onRunStart: enqueueOutbound,
            ...(opts.runHooks !== undefined && { hooks: opts.runHooks }),
          });
          runWorker.start();
          evalWorker = new EvalWorker({
            db: kdb,
            redisUrl: config.redis.url,
            quota: new OrgQuota(redis, EVAL_QUOTA_PREFIX),
            config: () => current,
            log,
            purposes,
            // 媒体按快照自己的组织与对话、经组织范围的附件接口取（C3）
            replay: {
              registry,
              config: () => current,
              ...(stepDeps.media !== undefined && { media: stepDeps.media }),
            },
            // 整轮回放（C6）：同一个 loop 工厂（同一 LangGraphLoop），只换工具管线（RecordedToolPipeline，
            // 从不执行工具）、计费的模型注册表与按原对话取附件的来源
            runReplay: {
              db: kdb,
              eventLog,
              config: () => current,
              log,
              registry,
              ...(stepDeps.media !== undefined && { media: stepDeps.media }),
              checkpoints,
              // explicitly without plugin hooks: eval replays never fire them (P-18)
              loop: (d) => {
                const { hooks: _noHooks, ...replayDeps } = stepDeps;
                return loopFactory({ ...replayDeps, ...d });
              },
              ...(opts.evalHooks !== undefined && { hooks: opts.evalHooks }),
            },
          });
          evalWorker.start();
          // 维护队列：周期任务的 scheduler（幂等，多副本重复登记无害）与唯一的 Worker。
          // 登记失败只记日志、不阻止启动（与 Worker 的连接错误同样处理）：任一 worker 副本下次启动时会再登记。
          try {
            await maintenance.ensureSchedules();
          } catch (err) {
            log.error("cannot register maintenance job schedulers", { err });
          }
          checkpoint();
          maintenance.startWorker();
          channelOutbound.startWorker();
          usageReporter.startWorker();
          if (!config.roles.includes("gateway")) {
            log.info(
              "this process runs the worker role without gateway; channel long connections are held only by processes with the gateway role",
              { roles: config.roles },
            );
          }
        }
        if (config.roles.includes("gateway")) {
          // Channel long-connection leader election: every gateway replica takes part, and only the
          // replica that holds a connection's lease connects it (E11-A)
          channelSupervisor = new ChannelSupervisor({
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
            config: () => current,
            log,
            replicaId,
          });
          await channelSupervisor.start();
          // 插件实例撤销 / 替换：交还它持有的长连接，按新实例重新选主（C17）
          const supervisor = channelSupervisor;
          unwatchPlugins = host.onChange((plugin) => supervisor.pluginChanged(plugin));
          checkpoint();
        }
        if (channelWebhooks) {
          // The webhook runtime cache is read-through only: drop entries on every connection change
          // and whenever a plugin instance changes
          const webhooks = channelWebhooks;
          unsubscribeWebhooks = await bus.subscribe(CHANNEL_CHANGED_TOPIC, (payload) => {
            const id = (payload as { connectionId?: unknown } | null)?.connectionId;
            if (typeof id === "string") webhooks.invalidate(id);
          });
          unwatchWebhooks = host.onChange(() => webhooks.invalidateAll());
          checkpoint();
        }
        // Routes stay mounted and are resolved live: 503 extension.unavailable after an extension is revoked, back after it reloads (C17)
        httpApp.mountPlugins(host.routeTable());
        // 订阅插件生命周期主题后补一次 reconcile（启动加载期间错过的消息，并写下第一轮心跳）
        await extensionLifecycle.start();
        checkpoint();
        await extensionLifecycle.reconcile("startup");
        checkpoint();
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
