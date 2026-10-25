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
import { ConversationOutputs } from "../conversations/outputs-read.js";
import { ConversationSandboxStatus } from "../conversations/sandbox-status.js";
import type { Keyring } from "../ctx/secrets.js";
import type { KernelDb } from "../db/kernel-schema.js";
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
import { UiViews } from "../ui/views.js";
import {
  ACCOUNTS,
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
  CONVERSATION_OUTPUTS,
  CONVERSATION_SANDBOX,
  CONVERSATION_STREAMS,
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
  IDENTITY_BINDING,
  INBOX,
  INVITATIONS,
  KERNEL_BUS,
  KERNEL_CONFIG,
  KERNEL_DB,
  KERNEL_LOG,
  KERNEL_REDIS,
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
  SKILLS,
  SSO_FLOW,
  TOOL_REGISTRY,
  TRAJECTORIES,
  UI_VIEWS,
} from "./tokens.js";

/** 内核 API 的依赖：由 createKernel 传入，ApiModule 据此构造各领域服务。 */
export interface ApiDeps {
  db: KernelDb;
  redis: Redis;
  keyring: Keyring;
  /** 取当前配置（热更新后返回新配置）。 */
  config: () => KernelConfig;
  log: Logger;
  host: ExtensionHost;
  /** The same instance as `Kernel.orgExtensionConfigs`. */
  orgExtensionConfigs: OrgExtensionConfigs;
  /** 内核总线（命名空间 `kernel`，插件名不能取 `kernel`，不会与插件冲突）。 */
  bus: EventBus;
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
  ModelsController,
  ConversationsController,
  AttachmentsController,
  SkillsController,
  SkillChangesController,
  AgentSkillsController,
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
function serviceProviders(deps: ApiDeps): Provider[] {
  return [
    { provide: KERNEL_LOG, useValue: deps.log },
    { provide: KERNEL_DB, useValue: deps.db },
    { provide: KERNEL_REDIS, useValue: deps.redis },
    { provide: KERNEL_CONFIG, useValue: deps.config },
    { provide: ORG_EXTENSION_CONFIGS, useValue: deps.orgExtensionConfigs },
    {
      provide: ACCOUNTS,
      useFactory: (db: KernelDb) => new AccountsService(db),
      inject: [KERNEL_DB],
    },
    {
      provide: SESSIONS,
      useFactory: (db: KernelDb, redis: Redis, config: () => KernelConfig) => {
        const { accessTokenTtlSeconds, refreshTokenTtlDays } = config().auth;
        return new SessionService(db, redis, deps.keyring, {
          accessTtlSeconds: accessTokenTtlSeconds,
          refreshTtlDays: refreshTokenTtlDays,
        });
      },
      inject: [KERNEL_DB, KERNEL_REDIS, KERNEL_CONFIG],
    },
    {
      provide: API_TOKENS,
      useFactory: (db: KernelDb) => new ApiTokenService(db),
      inject: [KERNEL_DB],
    },
    {
      provide: SETTINGS,
      useFactory: (db: KernelDb) => new SettingsService(db, deps.log),
      inject: [KERNEL_DB],
    },
    {
      provide: ORGS,
      useFactory: (db: KernelDb, settings: SettingsService, tokens: ApiTokenService) =>
        new OrgsService(db, settings, tokens, {
          afterDelete: (orgId) => deps.channels.notifyOrgChanged(orgId),
        }),
      inject: [KERNEL_DB, SETTINGS, API_TOKENS],
    },
    {
      provide: ORG_SETTINGS,
      useFactory: (db: KernelDb, config: () => KernelConfig) => new OrgSettingsService(db, config),
      inject: [KERNEL_DB, KERNEL_CONFIG],
    },
    {
      provide: MEMBERS,
      useFactory: (db: KernelDb) => new MembersService(db, deps.identity.offboarding),
      inject: [KERNEL_DB],
    },
    {
      provide: INVITATIONS,
      useFactory: (db: KernelDb, accounts: AccountsService, members: MembersService) =>
        new InvitationsService(db, accounts, members),
      inject: [KERNEL_DB, ACCOUNTS, MEMBERS],
    },
    {
      provide: SETUP,
      useFactory: (db: KernelDb, accounts: AccountsService, orgs: OrgsService) =>
        new SetupService(db, accounts, orgs),
      inject: [KERNEL_DB, ACCOUNTS, ORGS],
    },
    {
      provide: RATE_LIMITER,
      useFactory: (redis: Redis) => new LoginRateLimiter(redis),
      inject: [KERNEL_REDIS],
    },
    { provide: PROVIDER_REGISTRY, useValue: deps.registry },
    {
      provide: AGENTS,
      useFactory: (db: KernelDb, registry: ProviderRegistry, tools: ToolRegistry) =>
        new AgentsService(db, registry, tools, deps.skillChanges, deps.sandboxDestroy, deps.log),
      inject: [KERNEL_DB, PROVIDER_REGISTRY, TOOL_REGISTRY],
    },
    { provide: PRICES, useValue: deps.prices },
    { provide: MODEL_PURPOSES, useValue: deps.purposes },
    { provide: EXTENSION_INSTALLS, useValue: deps.extensionInstalls },
    { provide: EXTENSION_ADMIN, useValue: deps.extensionAdmin },
    { provide: EXTENSION_ADMIN_OPS, useValue: deps.extensionAdminOps },
    { provide: EXTENSION_DEPLOYMENT_CONFIGS, useValue: deps.extensionDeploymentConfigs },
    { provide: CATALOG, useValue: deps.catalog },
    { provide: PLUGIN_IMPORT, useValue: deps.pluginImport },
    { provide: MARKETPLACES, useValue: deps.marketplaces },
    {
      provide: TRAJECTORIES,
      useFactory: (
        db: KernelDb,
        eventLog: EventLog,
        prices: PricesService,
        settings: SettingsService,
      ) => new TrajectoryService(db, eventLog, prices, settings),
      inject: [KERNEL_DB, EVENT_LOG, PRICES, SETTINGS],
    },
    {
      provide: EVAL_SETS,
      useFactory: (
        db: KernelDb,
        config: () => KernelConfig,
        prices: PricesService,
        settings: SettingsService,
      ) => new EvalSetsService(db, config, prices, settings),
      inject: [KERNEL_DB, KERNEL_CONFIG, PRICES, SETTINGS],
    },
    {
      provide: EVAL_RUNS,
      useFactory: (
        db: KernelDb,
        config: () => KernelConfig,
        registry: ProviderRegistry,
        prices: PricesService,
        settings: SettingsService,
        redis: Redis,
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
      inject: [KERNEL_DB, KERNEL_CONFIG, PROVIDER_REGISTRY, PRICES, SETTINGS, KERNEL_REDIS],
    },
    { provide: KERNEL_BUS, useValue: deps.bus },
    { provide: EVENT_LOG, useValue: deps.eventLog },
    { provide: CONNECTOR_CONTENT, useValue: deps.connectorContent },
    { provide: ATTACHMENTS, useValue: deps.attachments },
    { provide: SKILLS, useValue: deps.skills },
    { provide: SKILL_CHANGES, useValue: deps.skillChanges },
    {
      provide: CATALOG_REQUESTS,
      useFactory: (db: KernelDb) => new CatalogRequestsService(db),
      inject: [KERNEL_DB],
    },
    {
      provide: INBOX,
      useFactory: (requests: CatalogRequestsService) =>
        new InboxService({
          approvals: deps.approvals,
          skillChanges: deps.skillChanges,
          catalogRequests: requests,
        }),
      inject: [CATALOG_REQUESTS],
    },
    {
      provide: PLUGIN_INSTALLER,
      useFactory: (db: KernelDb, connectors: ConnectorsService, requests: CatalogRequestsService) =>
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
      inject: [KERNEL_DB, CONNECTORS, CATALOG_REQUESTS],
    },
    {
      provide: ORG_CATALOG,
      useFactory: (
        db: KernelDb,
        requests: CatalogRequestsService,
        pluginInstaller: PluginInstaller,
      ) =>
        new OrgCatalogService({
          db,
          storage: deps.storage,
          host: deps.host,
          findConnector: findConnectorOf(deps.host),
          requests,
          pluginInstaller,
          log: deps.log,
        }),
      inject: [KERNEL_DB, CATALOG_REQUESTS, PLUGIN_INSTALLER],
    },
    {
      provide: CONVERSATIONS,
      useFactory: (
        db: KernelDb,
        eventLog: EventLog,
        agents: AgentsService,
        content: ConnectorContent,
        attachments: AttachmentsService,
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
        ),
      inject: [KERNEL_DB, EVENT_LOG, AGENTS, CONNECTOR_CONTENT, ATTACHMENTS],
    },
    {
      provide: CONVERSATION_OUTPUTS,
      useFactory: (conversations: ConversationsService) =>
        new ConversationOutputs({
          isAccessible: (orgId, id, viewer) => conversations.isAccessible(orgId, id, viewer),
          load: (scope, id) => deps.outputs.load(scope, id),
        }),
      inject: [CONVERSATIONS],
    },
    {
      provide: CONVERSATION_ARTIFACTS,
      useFactory: (db: KernelDb, conversations: ConversationsService) =>
        new ConversationArtifacts({
          db,
          storage: deps.storage,
          isAccessible: (orgId, id, viewer) => conversations.isAccessible(orgId, id, viewer),
        }),
      inject: [KERNEL_DB, CONVERSATIONS],
    },
    {
      provide: CONVERSATION_SANDBOX,
      useFactory: (conversations: ConversationsService) =>
        new ConversationSandboxStatus({
          sandbox: deps.sandbox,
          isAccessible: (orgId, id, viewer) => conversations.isAccessible(orgId, id, viewer),
        }),
      inject: [CONVERSATIONS],
    },
    {
      provide: CONVERSATION_STREAMS,
      useFactory: (
        eventLog: EventLog,
        bus: StreamBus,
        conversations: ConversationsService,
        config: () => KernelConfig,
      ) =>
        new ConversationStreams({
          eventLog,
          bus,
          access: (orgId, id, viewer) => conversations.isAccessible(orgId, id, viewer),
          config,
          log: deps.log,
        }),
      inject: [EVENT_LOG, KERNEL_BUS, CONVERSATIONS, KERNEL_CONFIG],
    },
    {
      provide: UI_VIEWS,
      useFactory: (conversations: ConversationsService) =>
        new UiViews({
          host: deps.host,
          // 内置插件始终启用（C14）
          enabledPlugins: (orgId) => deps.host.enabledPlugins(orgId),
          canAccessConversation: (orgId, id, accountId) =>
            conversations.isAccessible(orgId, id, accountId),
          log: deps.log,
        }),
      inject: [CONVERSATIONS],
    },
    { provide: EMBED_TOKENS, useFactory: () => new EmbedTokens(deps.keyring) },
    {
      provide: ORG_UI_STREAMS,
      useFactory: (db: KernelDb, bus: StreamBus, config: () => KernelConfig) =>
        new OrgUiStreams({ bus, memberRole: orgMembership(db), config, log: deps.log }),
      inject: [KERNEL_DB, KERNEL_BUS, KERNEL_CONFIG],
    },
    { provide: CREDENTIALS, useValue: deps.credentials },
    { provide: EXTERNAL_IDENTITIES, useValue: deps.identity.external },
    { provide: IDENTITY_BINDING, useValue: deps.identity.binding },
    { provide: SSO_FLOW, useValue: deps.identity.sso },
    { provide: OFFBOARDING, useValue: deps.identity.offboarding },
    { provide: CHANNEL_CONNECTIONS, useValue: deps.channels },
    { provide: DIRECTORY_SYNC, useValue: deps.identity.directory },
    { provide: TOOL_REGISTRY, useValue: deps.toolRegistry },
    { provide: APPROVALS, useValue: deps.approvals },
    { provide: QUESTIONS, useValue: deps.questions },
    {
      provide: CONNECTORS,
      useFactory: (
        db: KernelDb,
        registry: ToolRegistry,
        credentials: Credentials,
        config: () => KernelConfig,
      ) => new ConnectorsService(db, registry, deps.host, credentials, config, deps.drift),
      inject: [KERNEL_DB, TOOL_REGISTRY, CREDENTIALS, KERNEL_CONFIG],
    },
    {
      provide: OAUTH_FLOW,
      useFactory: (
        db: KernelDb,
        redis: Redis,
        credentials: Credentials,
        config: () => KernelConfig,
        connectors: ConnectorsService,
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
      inject: [KERNEL_DB, KERNEL_REDIS, CREDENTIALS, KERNEL_CONFIG, CONNECTORS],
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
  static register(deps: ApiDeps): DynamicModule {
    return {
      module: ApiModule,
      controllers: CONTROLLERS,
      providers: [...serviceProviders(deps), { provide: APP_GUARD, useClass: AuthGuard }],
    };
  }
}
