import type { Connector, Logger } from "@capybara-hq/plugin-sdk";
import { type DynamicModule, Module, type Provider, type Type } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import type { Redis } from "ioredis";
import { AdminController } from "../admin/admin.controller.js";
import { AdminExtensionsController } from "../admin/extensions.controller.js";
import { SetupController } from "../admin/setup.controller.js";
import { SetupService } from "../admin/setup.service.js";
import { AgentsController } from "../agents/agents.controller.js";
import { AgentsService } from "../agents/agents.service.js";
import { ModelsController } from "../agents/models.controller.js";
import { AgentTemplatesController } from "../agents/templates.controller.js";
import { AgentTemplatesService } from "../agents/templates.js";
import { AdminCatalogController } from "../catalog/admin-catalog.controller.js";
import type { CatalogService } from "../catalog/catalog.service.js";
import { MarketplacesController } from "../catalog/marketplaces.controller.js";
import type { MarketplacesService } from "../catalog/marketplaces.service.js";
import {
  AdminCatalogRequestsController,
  OrgCatalogController,
} from "../catalog/org-catalog.controller.js";
import { OrgCatalogService } from "../catalog/org-catalog.service.js";
import type { PluginImport } from "../catalog/plugin-import.js";
import { PluginInstaller } from "../catalog/plugin-install.js";
import { PluginUpgrader } from "../catalog/plugin-upgrade.js";
import { CatalogRequestsService } from "../catalog/requests.service.js";
import { ChannelConnectionsController } from "../channels/connections.controller.js";
import type { ChannelConnections } from "../channels/connections.service.js";
import type { KernelConfig } from "../config/schema.js";
import { ConversationArtifacts } from "../conversations/artifacts.js";
import { AttachmentsController } from "../conversations/attachments.controller.js";
import type { AttachmentsService } from "../conversations/attachments.service.js";
import { ConversationsController } from "../conversations/conversations.controller.js";
import { ConversationsService, type RunControl } from "../conversations/conversations.service.js";
import type { EventBus, EventLog } from "../conversations/event-log.js";
import { ConversationFiles } from "../conversations/files.js";
import { ConversationOutputs } from "../conversations/outputs-read.js";
import { ConversationQueue } from "../conversations/queue.js";
import { ConversationSandboxStatus } from "../conversations/sandbox-status.js";
import type { Keyring } from "../ctx/secrets.js";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { EvalRunsController } from "../evals/runs.controller.js";
import { type EvalQueue, EvalRunsService } from "../evals/runs.service.js";
import { EvalSetsController } from "../evals/sets.controller.js";
import { EvalSetsService } from "../evals/sets.service.js";
import { TrajectoryController } from "../evals/trajectory.controller.js";
import { TrajectoryService } from "../evals/trajectory.service.js";
import type { ExtensionAdminOps } from "../extensions/admin-ops.js";
import type { ExtensionAdmin } from "../extensions/admin-view.js";
import type { ExtensionDeploymentConfigService } from "../extensions/deployment-config.js";
import type { ExtensionHost } from "../extensions/host.js";
import type { ExtensionInstalls } from "../extensions/installs.js";
import { OrgExtensionConfigsController } from "../extensions/org-config.controller.js";
import type { OrgExtensionConfigs } from "../extensions/org-config.js";
import { FilePreviewersController } from "../files/previewers.controller.js";
import { PreviewerRegistry } from "../files/previewers.js";
import { AccountsService } from "../identity/accounts.js";
import { ApiTokenService } from "../identity/api-tokens.js";
import { AuthController } from "../identity/auth.controller.js";
import { AuthGuard } from "../identity/auth.guard.js";
import { MeController } from "../identity/me.controller.js";
import { LoginRateLimiter } from "../identity/rate-limit.js";
import { SessionService } from "../identity/sessions.js";
import { SettingsService } from "../identity/settings.js";
import {
  BindController,
  MeIdentitiesController,
  SsoController,
} from "../identity/sso.controller.js";
import { InboxService } from "../inbox/inbox.service.js";
import { GracefulShutdown } from "../infra/lifecycle/graceful-shutdown.service.js";
import { KERNEL_BUS, KERNEL_LOGGER, REDIS } from "../infra/tokens.js";
import type { KernelIdentity } from "../kernel.js";
import type { PricesService } from "../models/prices.js";
import { ModelPurposesController } from "../models/purposes.controller.js";
import type { ModelPurposesService } from "../models/purposes.js";
import { DirectorySyncController } from "../orgs/directory-sync.controller.js";
import { InvitationsController } from "../orgs/invitations.controller.js";
import { InvitationsService } from "../orgs/invitations.service.js";
import { MembersService } from "../orgs/members.service.js";
import { OrgsController } from "../orgs/orgs.controller.js";
import { OrgsService } from "../orgs/orgs.service.js";
import { OrgSettingsController } from "../orgs/settings.controller.js";
import { OrgSettingsService } from "../orgs/settings.service.js";
import type { ProviderRegistry } from "../runtime/providers.js";
import { ConversationStreamController } from "../runtime/stream.controller.js";
import { ConversationStreams, type StreamBus } from "../runtime/stream.js";
import type { SandboxService } from "../sandbox/sandbox.service.js";
import {
  AgentSkillsController,
  InboxController,
  SkillChangesController,
} from "../skills/changes.controller.js";
import type { SkillChangesService } from "../skills/changes.service.js";
import { InvocableSkillsController } from "../skills/invocable.controller.js";
import { SkillInvoker } from "../skills/invoke.js";
import { SkillsController } from "../skills/skills.controller.js";
import type { SkillsService } from "../skills/skills.service.js";
import type { StorageService } from "../storage/storage.service.js";
import { ApprovalsController, ToolGrantsController } from "../tools/approvals.controller.js";
import type { ApprovalsService } from "../tools/approvals.service.js";
import { ConnectorContentController } from "../tools/connector-content.controller.js";
import type { ConnectorContent } from "../tools/connector-content.js";
import { ConnectorsController } from "../tools/connectors.controller.js";
import { ConnectorsService } from "../tools/connectors.service.js";
import type { Credentials } from "../tools/credentials.js";
import type { ToolDrift } from "../tools/drift.js";
import { ConversationToolInfo } from "../tools/info.js";
import { OAuthFlow } from "../tools/oauth/flow.js";
import {
  OAuthCallbackController,
  OAuthConnectController,
} from "../tools/oauth/oauth.controller.js";
import type { ToolOutputs } from "../tools/outputs.js";
import { QuestionsController } from "../tools/questions.controller.js";
import type { QuestionsService } from "../tools/questions.service.js";
import type { ToolRegistry } from "../tools/registry.js";
import { EmbedTokens } from "../ui/embed-token.js";
import { OrgUiStreams, orgMembership } from "../ui/ui-stream.js";
import { UiController } from "../ui/views.controller.js";
import { recordedCard, UiViews } from "../ui/views.js";
import {
  ACCOUNTS,
  AGENT_TEMPLATES,
  AGENTS,
  API_TOKENS,
  APPROVALS,
  ATTACHMENTS,
  CATALOG,
  CATALOG_REQUESTS,
  CHANNEL_CONNECTIONS,
  CONNECTOR_CONTENT,
  CONNECTORS,
  CONVERSATION_ARTIFACTS,
  CONVERSATION_FILES,
  CONVERSATION_OUTPUTS,
  CONVERSATION_QUEUE,
  CONVERSATION_SANDBOX,
  CONVERSATION_STREAMS,
  CONVERSATION_TOOLS,
  CONVERSATIONS,
  CREDENTIALS,
  DIRECTORY_SYNC,
  EMBED_TOKENS,
  EVAL_RUNS,
  EVAL_SETS,
  EVENT_LOG,
  EXTENSION_ADMIN,
  EXTENSION_ADMIN_OPS,
  EXTENSION_DEPLOYMENT_CONFIGS,
  EXTENSION_INSTALLS,
  EXTERNAL_IDENTITIES,
  FILE_PREVIEWERS,
  IDENTITY_BINDING,
  INBOX,
  INVITATIONS,
  KERNEL_CONFIG,
  KERNEL_DB,
  MARKETPLACES,
  MEMBERS,
  MODEL_PURPOSES,
  OAUTH_FLOW,
  OFFBOARDING,
  ORG_CATALOG,
  ORG_EXTENSION_CONFIGS,
  ORG_SETTINGS,
  ORG_UI_STREAMS,
  ORGS,
  PLUGIN_IMPORT,
  PLUGIN_INSTALLER,
  PRICES,
  PROVIDER_REGISTRY,
  QUESTIONS,
  RATE_LIMITER,
  SESSIONS,
  SETTINGS,
  SETUP,
  SKILL_CHANGES,
  SKILL_INVOKER,
  SKILLS,
  SSO_FLOW,
  TOOL_REGISTRY,
  TRAJECTORIES,
  UI_VIEWS,
} from "./tokens.js";

/** The injection token of {@link ApiDeps} inside `ApiModule`. */
export const API_DEPS = Symbol("API_DEPS");

/** 内核 API 的依赖：由 createKernel 传入，ApiModule 据此构造各领域服务。 */
export interface ApiDeps {
  db: KernelSchemaDb;
  keyring: Keyring;
  /** 取当前配置（热更新后返回新配置）。 */
  config: () => KernelConfig;
  log: Logger;
  host: ExtensionHost;
  /** The same instance as `Kernel.orgExtensionConfigs`. */
  orgExtensionConfigs: OrgExtensionConfigs;
  /** 内核总线（命名空间 `kernel`，插件名不能取 `kernel`，不会与插件冲突）。 */
  /** 会话事件日志（与运行 worker 共用同一实例）。 */
  eventLog: EventLog;
  /** 模型供应商注册表（与运行 worker 共用同一实例）。 */
  registry: ProviderRegistry;
  /** 运行投递与中止。 */
  runs: RunControl;
  /** 连接器凭据（与 `Kernel.tools.credentials` 同一实例）。 */
  credentials: Credentials;
  /** 工具注册表（与 `Kernel.tools.registry` 同一实例）。 */
  toolRegistry: ToolRegistry;
  /** 工具调用审批（与 `Kernel.tools.approvals` 同一实例）。 */
  approvals: ApprovalsService;
  /** 工具调用的输入请求（与 `Kernel.tools.questions` 同一实例）。 */
  questions: QuestionsService;
  /** 工具定义漂移检测（与 `Kernel.tools.drift` 同一实例；手动刷新走同一套比对）。 */
  drift: ToolDrift;
  /** 工具输出存档（与 `Kernel.tools.outputs` 同一实例；网页的运行标签读全文）。 */
  outputs: ToolOutputs;
  /** 连接器的 prompts / resources（斜杠命令、@ 资源引用与消息附件）。 */
  connectorContent: ConnectorContent;
  /** 外部身份、绑定、第三方登录与离职处理（与 `Kernel.identity` 同一组实例）。 */
  identity: KernelIdentity;
  /** 渠道连接（与 `Kernel.channels.connections` 同一实例）。 */
  channels: ChannelConnections;
  /** 对话附件（与 `Kernel.attachments` 同一实例）。 */
  attachments: AttachmentsService;
  /** 对象存储（与 `Kernel.storage` 同一实例；产物下载用）。 */
  storage: StorageService;
  /** 按对话的沙箱（与 `Kernel.sandbox` 同一实例；上下文标签读状态）。 */
  sandbox: SandboxService;
  /** 技能库（与 `Kernel.skills` 同一实例）。 */
  skills: SkillsService;
  /** agent 自写技能与技能变更审批（与 `Kernel.skillChanges` 同一实例）。 */
  skillChanges: SkillChangesService;
  /** 模型价格表（与 `Kernel.prices` 同一实例）。 */
  prices: PricesService;
  /** 模型用途映射（与 `Kernel.purposes` 同一实例；评测 worker 的评委也用它）。 */
  purposes: ModelPurposesService;
  /** Extension package imports and install records (the same instance as `Kernel.extensionInstalls`). */
  extensionInstalls: ExtensionInstalls;
  /** Deployment-level extension admin: list and web approval (the same instance as `Kernel.extensionAdmin`). */
  extensionAdmin: ExtensionAdmin;
  /** Deployment-level extension install / enable / disable / uninstall (the same instance as `Kernel.extensionAdminOps`). */
  extensionAdminOps: ExtensionAdminOps;
  /** Deployment-level extension config (the same instance as `Kernel.extensionDeploymentConfigs`). */
  extensionDeploymentConfigs: ExtensionDeploymentConfigService;
  /** The enterprise catalog (the same instance as `Kernel.catalog`). */
  catalog: CatalogService;
  /** Plugin (app bundle) import (the same instance as `Kernel.pluginImport`). */
  pluginImport: PluginImport;
  /** Marketplaces (the same instance as `Kernel.marketplaces`). */
  marketplaces: MarketplacesService;
  /** 评测队列的生产方（与 worker 同一队列名）。 */
  evalQueue: Pick<EvalQueue, "enqueue">;
  /** 删除 agent 后投递销毁它各对话的沙箱（一次性维护任务）；不给时留给不活跃销毁扫描。 */
  sandboxDestroy?: { destroy(conversationIds: string[]): Promise<void> };
}

/** 本副本已加载的连接器：插件 `plugin` 提供的 `Connector.kind === kind`。 */
const findConnectorOf =
  (host: ApiDeps["host"]) =>
  (plugin: string, kind: string): Connector | undefined =>
    host
      .list("connector")
      .find((e) => e.plugin === plugin && (e.impl as Connector | undefined)?.kind === kind)?.impl as
      | Connector
      | undefined;

/** 内核 API 的全部 controller；后续任务往这里追加。 */
const CONTROLLERS: Type[] = [
  AuthController,
  MeController,
  OrgsController,
  OrgSettingsController,
  InvitationsController,
  SetupController,
  AdminController,
  AdminExtensionsController,
  AdminCatalogController,
  MarketplacesController,
  OrgExtensionConfigsController,
  AgentsController,
  AgentTemplatesController,
  ModelsController,
  ConversationsController,
  AttachmentsController,
  SkillsController,
  SkillChangesController,
  AgentSkillsController,
  InvocableSkillsController,
  InboxController,
  ConversationStreamController,
  ConnectorContentController,
  ConnectorsController,
  ApprovalsController,
  ToolGrantsController,
  QuestionsController,
  OAuthConnectController,
  OAuthCallbackController,
  SsoController,
  BindController,
  MeIdentitiesController,
  ChannelConnectionsController,
  DirectorySyncController,
  UiController,
  FilePreviewersController,
  TrajectoryController,
  EvalSetsController,
  EvalRunsController,
  ModelPurposesController,
  OrgCatalogController,
  AdminCatalogRequestsController,
];

/**
 * 领域服务 provider：领域类保持框架无关（不加装饰器），一律用 `useFactory` 构造。
 * 后续任务往这里追加。
 */
/**
 * Closes a stream registry's streams when the shutdown begins (readiness answers 503 from that
 * moment), and latches it: streams opened afterwards end at once, so the HTTP phase of the stop
 * never waits on an event stream. A standalone HTTP application (`createHttpApp` without the
 * kernel application, tests only) has no `GracefulShutdown`: its streams end with their connections.
 */
function closeOnShutdown<T extends { closeAll(): void }>(
  streams: T,
  shutdown: GracefulShutdown | undefined,
): T {
  if (shutdown?.signal.aborted) streams.closeAll();
  else shutdown?.signal.addEventListener("abort", () => streams.closeAll(), { once: true });
  return streams;
}

function serviceProviders(): Provider[] {
  return [
    { provide: KERNEL_DB, useFactory: (deps: ApiDeps) => deps.db, inject: [API_DEPS] },
    { provide: KERNEL_CONFIG, useFactory: (deps: ApiDeps) => deps.config, inject: [API_DEPS] },
    {
      provide: ORG_EXTENSION_CONFIGS,
      useFactory: (deps: ApiDeps) => deps.orgExtensionConfigs,
      inject: [API_DEPS],
    },
    {
      provide: ACCOUNTS,
      useFactory: (db: KernelSchemaDb) => new AccountsService(db),
      inject: [KERNEL_DB],
    },
    {
      provide: SESSIONS,
      useFactory: (db: KernelSchemaDb, redis: Redis, config: () => KernelConfig, deps: ApiDeps) => {
        const { accessTokenTtlSeconds, refreshTokenTtlDays } = config().auth;
        return new SessionService(db, redis, deps.keyring, {
          accessTtlSeconds: accessTokenTtlSeconds,
          refreshTtlDays: refreshTokenTtlDays,
        });
      },
      inject: [KERNEL_DB, REDIS, KERNEL_CONFIG, API_DEPS],
    },
    {
      provide: API_TOKENS,
      useFactory: (db: KernelSchemaDb) => new ApiTokenService(db),
      inject: [KERNEL_DB],
    },
    {
      provide: SETTINGS,
      useFactory: (db: KernelSchemaDb, deps: ApiDeps) => new SettingsService(db, deps.log),
      inject: [KERNEL_DB, API_DEPS],
    },
    {
      provide: ORGS,
      useFactory: (
        db: KernelSchemaDb,
        settings: SettingsService,
        tokens: ApiTokenService,
        deps: ApiDeps,
      ) =>
        new OrgsService(db, settings, tokens, {
          afterDelete: (orgId) => deps.channels.notifyOrgChanged(orgId),
        }),
      inject: [KERNEL_DB, SETTINGS, API_TOKENS, API_DEPS],
    },
    {
      provide: ORG_SETTINGS,
      useFactory: (db: KernelSchemaDb, config: () => KernelConfig) =>
        new OrgSettingsService(db, config),
      inject: [KERNEL_DB, KERNEL_CONFIG],
    },
    {
      provide: MEMBERS,
      useFactory: (db: KernelSchemaDb, deps: ApiDeps) =>
        new MembersService(db, deps.identity.offboarding),
      inject: [KERNEL_DB, API_DEPS],
    },
    {
      provide: INVITATIONS,
      useFactory: (db: KernelSchemaDb, accounts: AccountsService, members: MembersService) =>
        new InvitationsService(db, accounts, members),
      inject: [KERNEL_DB, ACCOUNTS, MEMBERS],
    },
    {
      provide: SETUP,
      useFactory: (db: KernelSchemaDb, accounts: AccountsService, orgs: OrgsService) =>
        new SetupService(db, accounts, orgs),
      inject: [KERNEL_DB, ACCOUNTS, ORGS],
    },
    {
      provide: RATE_LIMITER,
      useFactory: (redis: Redis) => new LoginRateLimiter(redis),
      inject: [REDIS],
    },
    {
      provide: PROVIDER_REGISTRY,
      useFactory: (deps: ApiDeps) => deps.registry,
      inject: [API_DEPS],
    },
    {
      provide: AGENT_TEMPLATES,
      useFactory: (db: KernelSchemaDb) => new AgentTemplatesService(db),
      inject: [KERNEL_DB],
    },
    {
      provide: AGENTS,
      useFactory: (
        db: KernelSchemaDb,
        registry: ProviderRegistry,
        tools: ToolRegistry,
        deps: ApiDeps,
      ) => new AgentsService(db, registry, tools, deps.skillChanges, deps.sandboxDestroy, deps.log),
      inject: [KERNEL_DB, PROVIDER_REGISTRY, TOOL_REGISTRY, API_DEPS],
    },
    { provide: PRICES, useFactory: (deps: ApiDeps) => deps.prices, inject: [API_DEPS] },
    { provide: MODEL_PURPOSES, useFactory: (deps: ApiDeps) => deps.purposes, inject: [API_DEPS] },
    {
      provide: EXTENSION_INSTALLS,
      useFactory: (deps: ApiDeps) => deps.extensionInstalls,
      inject: [API_DEPS],
    },
    {
      provide: EXTENSION_ADMIN,
      useFactory: (deps: ApiDeps) => deps.extensionAdmin,
      inject: [API_DEPS],
    },
    {
      provide: EXTENSION_ADMIN_OPS,
      useFactory: (deps: ApiDeps) => deps.extensionAdminOps,
      inject: [API_DEPS],
    },
    {
      provide: EXTENSION_DEPLOYMENT_CONFIGS,
      useFactory: (deps: ApiDeps) => deps.extensionDeploymentConfigs,
      inject: [API_DEPS],
    },
    { provide: CATALOG, useFactory: (deps: ApiDeps) => deps.catalog, inject: [API_DEPS] },
    {
      provide: PLUGIN_IMPORT,
      useFactory: (deps: ApiDeps) => deps.pluginImport,
      inject: [API_DEPS],
    },
    { provide: MARKETPLACES, useFactory: (deps: ApiDeps) => deps.marketplaces, inject: [API_DEPS] },
    {
      provide: TRAJECTORIES,
      useFactory: (
        db: KernelSchemaDb,
        eventLog: EventLog,
        prices: PricesService,
        settings: SettingsService,
      ) => new TrajectoryService(db, eventLog, prices, settings),
      inject: [KERNEL_DB, EVENT_LOG, PRICES, SETTINGS],
    },
    {
      provide: EVAL_SETS,
      useFactory: (
        db: KernelSchemaDb,
        config: () => KernelConfig,
        prices: PricesService,
        settings: SettingsService,
      ) => new EvalSetsService(db, config, prices, settings),
      inject: [KERNEL_DB, KERNEL_CONFIG, PRICES, SETTINGS],
    },
    {
      provide: EVAL_RUNS,
      useFactory: (
        db: KernelSchemaDb,
        config: () => KernelConfig,
        registry: ProviderRegistry,
        prices: PricesService,
        settings: SettingsService,
        redis: Redis,
        deps: ApiDeps,
      ) =>
        new EvalRunsService({
          db,
          redis,
          config,
          registry,
          prices,
          settings,
          queue: deps.evalQueue,
          purposes: deps.purposes,
        }),
      inject: [KERNEL_DB, KERNEL_CONFIG, PROVIDER_REGISTRY, PRICES, SETTINGS, REDIS, API_DEPS],
    },
    { provide: EVENT_LOG, useFactory: (deps: ApiDeps) => deps.eventLog, inject: [API_DEPS] },
    {
      provide: CONNECTOR_CONTENT,
      useFactory: (deps: ApiDeps) => deps.connectorContent,
      inject: [API_DEPS],
    },
    { provide: ATTACHMENTS, useFactory: (deps: ApiDeps) => deps.attachments, inject: [API_DEPS] },
    { provide: SKILLS, useFactory: (deps: ApiDeps) => deps.skills, inject: [API_DEPS] },
    {
      provide: SKILL_CHANGES,
      useFactory: (deps: ApiDeps) => deps.skillChanges,
      inject: [API_DEPS],
    },
    {
      provide: SKILL_INVOKER,
      useFactory: (db: KernelSchemaDb, agents: AgentsService, deps: ApiDeps) =>
        new SkillInvoker({ db, storage: deps.storage, agents, log: deps.log }),
      inject: [KERNEL_DB, AGENTS, API_DEPS],
    },
    {
      provide: CATALOG_REQUESTS,
      useFactory: (db: KernelSchemaDb) => new CatalogRequestsService(db),
      inject: [KERNEL_DB],
    },
    {
      provide: INBOX,
      useFactory: (requests: CatalogRequestsService, deps: ApiDeps) =>
        new InboxService({
          approvals: deps.approvals,
          skillChanges: deps.skillChanges,
          catalogRequests: requests,
        }),
      inject: [CATALOG_REQUESTS, API_DEPS],
    },
    {
      provide: PLUGIN_INSTALLER,
      useFactory: (
        db: KernelSchemaDb,
        connectors: ConnectorsService,
        requests: CatalogRequestsService,
        deps: ApiDeps,
      ) =>
        new PluginInstaller({
          db,
          storage: deps.storage,
          host: deps.host,
          findConnector: findConnectorOf(deps.host),
          connectors,
          skills: deps.skills,
          orgConfigs: deps.orgExtensionConfigs,
          requests,
          log: deps.log,
          staleInstallMinutes: () => deps.config().catalog.staleInstallMinutes,
        }),
      inject: [KERNEL_DB, CONNECTORS, CATALOG_REQUESTS, API_DEPS],
    },
    {
      provide: ORG_CATALOG,
      useFactory: (
        db: KernelSchemaDb,
        requests: CatalogRequestsService,
        pluginInstaller: PluginInstaller,
        deps: ApiDeps,
      ) =>
        new OrgCatalogService({
          db,
          storage: deps.storage,
          host: deps.host,
          findConnector: findConnectorOf(deps.host),
          requests,
          pluginInstaller,
          pluginUpgrader: new PluginUpgrader(pluginInstaller),
          log: deps.log,
        }),
      inject: [KERNEL_DB, CATALOG_REQUESTS, PLUGIN_INSTALLER, API_DEPS],
    },
    {
      provide: CONVERSATIONS,
      useFactory: (
        db: KernelSchemaDb,
        eventLog: EventLog,
        agents: AgentsService,
        content: ConnectorContent,
        attachments: AttachmentsService,
        invoker: SkillInvoker,
        deps: ApiDeps,
      ) =>
        new ConversationsService(
          db,
          eventLog,
          agents,
          deps.runs,
          deps.log,
          (orgId, accountId, refs) => content.resolveAttachments(orgId, accountId, refs),
          (trx, orgId, conversationId, accountId, ids) =>
            attachments.bindForMessage(trx, orgId, conversationId, accountId, ids),
          deps.registry,
          invoker,
        ),
      inject: [
        KERNEL_DB,
        EVENT_LOG,
        AGENTS,
        CONNECTOR_CONTENT,
        ATTACHMENTS,
        SKILL_INVOKER,
        API_DEPS,
      ],
    },
    {
      provide: CONVERSATION_OUTPUTS,
      useFactory: (conversations: ConversationsService, deps: ApiDeps) =>
        new ConversationOutputs({
          isAccessible: (orgId, id, viewer) => conversations.isAccessible(orgId, id, viewer),
          load: (scope, id) => deps.outputs.load(scope, id),
        }),
      inject: [CONVERSATIONS, API_DEPS],
    },
    {
      provide: CONVERSATION_ARTIFACTS,
      useFactory: (db: KernelSchemaDb, conversations: ConversationsService, deps: ApiDeps) =>
        new ConversationArtifacts({
          db,
          storage: deps.storage,
          isAccessible: (orgId, id, viewer) => conversations.isAccessible(orgId, id, viewer),
        }),
      inject: [KERNEL_DB, CONVERSATIONS, API_DEPS],
    },
    {
      provide: CONVERSATION_FILES,
      useFactory: (db: KernelSchemaDb, conversations: ConversationsService, deps: ApiDeps) =>
        new ConversationFiles({
          db,
          storage: deps.storage,
          isAccessible: (orgId, id, viewer) => conversations.isAccessible(orgId, id, viewer),
        }),
      inject: [KERNEL_DB, CONVERSATIONS, API_DEPS],
    },
    {
      provide: CONVERSATION_QUEUE,
      useFactory: (
        db: KernelSchemaDb,
        eventLog: EventLog,
        conversations: ConversationsService,
        deps: ApiDeps,
      ) => new ConversationQueue({ db, eventLog, conversations, runs: deps.runs }),
      inject: [KERNEL_DB, EVENT_LOG, CONVERSATIONS, API_DEPS],
    },
    {
      provide: CONVERSATION_SANDBOX,
      useFactory: (conversations: ConversationsService, deps: ApiDeps) =>
        new ConversationSandboxStatus({
          sandbox: deps.sandbox,
          isAccessible: (orgId, id, viewer) => conversations.isAccessible(orgId, id, viewer),
          sandboxConversationOf: (orgId, id) => conversations.sandboxConversationOf(orgId, id),
        }),
      inject: [CONVERSATIONS, API_DEPS],
    },
    {
      provide: CONVERSATION_TOOLS,
      useFactory: (db: KernelSchemaDb, conversations: ConversationsService, deps: ApiDeps) =>
        new ConversationToolInfo({
          db,
          registry: deps.toolRegistry,
          isAccessible: (orgId, id, viewer) => conversations.isAccessible(orgId, id, viewer),
        }),
      inject: [KERNEL_DB, CONVERSATIONS, API_DEPS],
    },
    {
      provide: CONVERSATION_STREAMS,
      useFactory: (
        eventLog: EventLog,
        bus: StreamBus,
        conversations: ConversationsService,
        config: () => KernelConfig,
        deps: ApiDeps,
        shutdown: GracefulShutdown | undefined,
      ) =>
        closeOnShutdown(
          new ConversationStreams({
            eventLog,
            bus,
            access: (orgId, id, viewer) => conversations.isAccessible(orgId, id, viewer),
            config,
            log: deps.log,
          }),
          shutdown,
        ),
      inject: [
        EVENT_LOG,
        KERNEL_BUS,
        CONVERSATIONS,
        KERNEL_CONFIG,
        API_DEPS,
        { token: GracefulShutdown, optional: true },
      ],
    },
    {
      provide: FILE_PREVIEWERS,
      useFactory: (db: KernelSchemaDb, files: ConversationFiles, deps: ApiDeps) =>
        new PreviewerRegistry({
          db,
          host: deps.host,
          enabledPlugins: (orgId) => deps.host.enabledPlugins(orgId),
          files,
          storage: deps.storage,
          log: deps.log,
        }),
      inject: [KERNEL_DB, CONVERSATION_FILES, API_DEPS],
    },
    {
      provide: UI_VIEWS,
      useFactory: (
        conversations: ConversationsService,
        previewers: PreviewerRegistry,
        db: KernelSchemaDb,
        deps: ApiDeps,
      ) =>
        new UiViews({
          host: deps.host,
          // org config rows plus the required bootstrap plugins
          enabledPlugins: (orgId) => deps.host.enabledPlugins(orgId),
          canAccessConversation: (orgId, id, accountId) =>
            conversations.isAccessible(orgId, id, accountId),
          checkWritable: async (orgId, id, accountId) => {
            await conversations.writable(orgId, id, accountId);
          },
          previewEmbedAllowed: (t) => previewers.embedAllowed(t),
          recordedCard: (conversationId, callId) => recordedCard(db, conversationId, callId),
          log: deps.log,
        }),
      inject: [CONVERSATIONS, FILE_PREVIEWERS, KERNEL_DB, API_DEPS],
    },
    {
      provide: EMBED_TOKENS,
      useFactory: (deps: ApiDeps) => new EmbedTokens(deps.keyring),
      inject: [API_DEPS],
    },
    {
      provide: ORG_UI_STREAMS,
      useFactory: (
        db: KernelSchemaDb,
        bus: StreamBus,
        config: () => KernelConfig,
        deps: ApiDeps,
        shutdown: GracefulShutdown | undefined,
      ) =>
        closeOnShutdown(
          new OrgUiStreams({ bus, memberRole: orgMembership(db), config, log: deps.log }),
          shutdown,
        ),
      inject: [
        KERNEL_DB,
        KERNEL_BUS,
        KERNEL_CONFIG,
        API_DEPS,
        { token: GracefulShutdown, optional: true },
      ],
    },
    { provide: CREDENTIALS, useFactory: (deps: ApiDeps) => deps.credentials, inject: [API_DEPS] },
    {
      provide: EXTERNAL_IDENTITIES,
      useFactory: (deps: ApiDeps) => deps.identity.external,
      inject: [API_DEPS],
    },
    {
      provide: IDENTITY_BINDING,
      useFactory: (deps: ApiDeps) => deps.identity.binding,
      inject: [API_DEPS],
    },
    { provide: SSO_FLOW, useFactory: (deps: ApiDeps) => deps.identity.sso, inject: [API_DEPS] },
    {
      provide: OFFBOARDING,
      useFactory: (deps: ApiDeps) => deps.identity.offboarding,
      inject: [API_DEPS],
    },
    {
      provide: CHANNEL_CONNECTIONS,
      useFactory: (deps: ApiDeps) => deps.channels,
      inject: [API_DEPS],
    },
    {
      provide: DIRECTORY_SYNC,
      useFactory: (deps: ApiDeps) => deps.identity.directory,
      inject: [API_DEPS],
    },
    {
      provide: TOOL_REGISTRY,
      useFactory: (deps: ApiDeps) => deps.toolRegistry,
      inject: [API_DEPS],
    },
    { provide: APPROVALS, useFactory: (deps: ApiDeps) => deps.approvals, inject: [API_DEPS] },
    { provide: QUESTIONS, useFactory: (deps: ApiDeps) => deps.questions, inject: [API_DEPS] },
    {
      provide: CONNECTORS,
      useFactory: (
        db: KernelSchemaDb,
        registry: ToolRegistry,
        credentials: Credentials,
        config: () => KernelConfig,
        deps: ApiDeps,
      ) => new ConnectorsService(db, registry, deps.host, credentials, config, deps.drift),
      inject: [KERNEL_DB, TOOL_REGISTRY, CREDENTIALS, KERNEL_CONFIG, API_DEPS],
    },
    {
      provide: OAUTH_FLOW,
      useFactory: (
        db: KernelSchemaDb,
        redis: Redis,
        credentials: Credentials,
        config: () => KernelConfig,
        connectors: ConnectorsService,
        deps: ApiDeps,
      ) =>
        new OAuthFlow({
          db,
          redis,
          credentials,
          config,
          log: deps.log,
          onFirstConnect: async (orgId, connectorId, accountId) => {
            await connectors.refresh(orgId, connectorId, accountId, undefined, {
              trigger: "first_connect",
            });
          },
        }),
      inject: [KERNEL_DB, REDIS, CREDENTIALS, KERNEL_CONFIG, CONNECTORS, API_DEPS],
    },
  ];
}

/**
 * 内核 API 模块（`/api/v1/*`），只在角色含 `api` 时挂载。
 * 全局守卫 `AuthGuard` 默认拒绝：未标注 `@Public()` 的路由一律要求凭据（含根模块的健康检查，它们显式标了 `@Public()`）。
 */
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: Nest 动态模块约定（`Module.register()` 返回 DynamicModule）
export class ApiModule {
  /** The API over the given dependencies. */
  static register(deps: ApiDeps): DynamicModule {
    return ApiModule.registerFrom({ provide: API_DEPS, useValue: deps });
  }

  /**
   * The API over dependencies another provider supplies (the kernel: its legacy graph, Task 1.2 of
   * the nest kernel plan; `deps` must provide {@link API_DEPS}).
   */
  static registerFrom(deps: Provider<ApiDeps> & { provide: typeof API_DEPS }): DynamicModule {
    return {
      module: ApiModule,
      controllers: CONTROLLERS,
      providers: [deps, ...serviceProviders(), { provide: APP_GUARD, useClass: AuthGuard }],
    };
  }
}
