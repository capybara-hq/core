import type { Logger } from "@capybara-hq/plugin-sdk";
import { type DynamicModule, Module, type Provider, type Type } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import type { Redis } from "ioredis";
import { AdminController } from "../admin/admin.controller.js";
import { SetupController } from "../admin/setup.controller.js";
import { SetupService } from "../admin/setup.service.js";
import { AgentsController } from "../agents/agents.controller.js";
import { AgentsService } from "../agents/agents.service.js";
import { ModelsController } from "../agents/models.controller.js";
import type { KernelConfig } from "../config/schema.js";
import { ConversationsController } from "../conversations/conversations.controller.js";
import { ConversationsService, type RunControl } from "../conversations/conversations.service.js";
import type { EventBus, EventLog } from "../conversations/event-log.js";
import type { Keyring } from "../ctx/secrets.js";
import type { KernelDb } from "../db/kernel-schema.js";
import { AccountsService } from "../identity/accounts.js";
import { ApiTokenService } from "../identity/api-tokens.js";
import { AuthController } from "../identity/auth.controller.js";
import { AuthGuard } from "../identity/auth.guard.js";
import { MeController } from "../identity/me.controller.js";
import { LoginRateLimiter } from "../identity/rate-limit.js";
import { SessionService } from "../identity/sessions.js";
import { SettingsService } from "../identity/settings.js";
import { InvitationsController } from "../orgs/invitations.controller.js";
import { InvitationsService } from "../orgs/invitations.service.js";
import { MembersService } from "../orgs/members.service.js";
import { OrgsController } from "../orgs/orgs.controller.js";
import { OrgsService } from "../orgs/orgs.service.js";
import type { PluginHost } from "../plugins/host.js";
import { OrgPluginConfigsController } from "../plugins/org-config.controller.js";
import type { OrgPluginConfigs } from "../plugins/org-config.js";
import type { ProviderRegistry } from "../runtime/providers.js";
import { ConversationStreamController } from "../runtime/stream.controller.js";
import { ConversationStreams, type StreamBus } from "../runtime/stream.js";
import { ApprovalsController, ToolGrantsController } from "../tools/approvals.controller.js";
import type { ApprovalsService } from "../tools/approvals.service.js";
import { AppsController } from "../tools/apps.controller.js";
import { AppsService } from "../tools/apps.service.js";
import type { Credentials } from "../tools/credentials.js";
import type { ToolRegistry } from "../tools/registry.js";
import {
  ACCOUNTS,
  AGENTS,
  API_TOKENS,
  APPROVALS,
  APPS,
  CONVERSATION_STREAMS,
  CONVERSATIONS,
  CREDENTIALS,
  EVENT_LOG,
  INVITATIONS,
  KERNEL_BUS,
  KERNEL_CONFIG,
  KERNEL_DB,
  KERNEL_LOG,
  KERNEL_REDIS,
  MEMBERS,
  ORG_PLUGIN_CONFIGS,
  ORGS,
  PROVIDER_REGISTRY,
  RATE_LIMITER,
  SESSIONS,
  SETTINGS,
  SETUP,
  TOOL_REGISTRY,
} from "./tokens.js";

/** 内核 API 的依赖：由 createKernel 传入，ApiModule 据此构造各领域服务。 */
export interface ApiDeps {
  db: KernelDb;
  redis: Redis;
  keyring: Keyring;
  /** 取当前配置（热更新后返回新配置）。 */
  config: () => KernelConfig;
  log: Logger;
  host: PluginHost;
  /** 与 `Kernel.orgPluginConfigs` 同一实例。 */
  orgPluginConfigs: OrgPluginConfigs;
  /** 内核总线（命名空间 `kernel`，插件名不能取 `kernel`，不会与插件冲突）。 */
  bus: EventBus;
  /** 会话事件日志（与运行 worker 共用同一实例）。 */
  eventLog: EventLog;
  /** 模型供应商注册表（与运行 worker 共用同一实例）。 */
  registry: ProviderRegistry;
  /** 运行投递与中止。 */
  runs: RunControl;
  /** 应用凭据（与 `Kernel.tools.credentials` 同一实例）。 */
  credentials: Credentials;
  /** 工具注册表（与 `Kernel.tools.registry` 同一实例）。 */
  toolRegistry: ToolRegistry;
  /** 工具调用审批（与 `Kernel.tools.approvals` 同一实例）。 */
  approvals: ApprovalsService;
}

/** 内核 API 的全部 controller；后续任务往这里追加。 */
const CONTROLLERS: Type[] = [
  AuthController,
  MeController,
  OrgsController,
  InvitationsController,
  SetupController,
  AdminController,
  OrgPluginConfigsController,
  AgentsController,
  ModelsController,
  ConversationsController,
  ConversationStreamController,
  AppsController,
  ApprovalsController,
  ToolGrantsController,
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
    { provide: ORG_PLUGIN_CONFIGS, useValue: deps.orgPluginConfigs },
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
        new OrgsService(db, settings, tokens),
      inject: [KERNEL_DB, SETTINGS, API_TOKENS],
    },
    {
      provide: MEMBERS,
      useFactory: (db: KernelDb) => new MembersService(db),
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
        new AgentsService(db, registry, tools),
      inject: [KERNEL_DB, PROVIDER_REGISTRY, TOOL_REGISTRY],
    },
    { provide: KERNEL_BUS, useValue: deps.bus },
    { provide: EVENT_LOG, useValue: deps.eventLog },
    {
      provide: CONVERSATIONS,
      useFactory: (db: KernelDb, eventLog: EventLog, agents: AgentsService) =>
        new ConversationsService(db, eventLog, agents, deps.runs, deps.log),
      inject: [KERNEL_DB, EVENT_LOG, AGENTS],
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
    { provide: CREDENTIALS, useValue: deps.credentials },
    { provide: TOOL_REGISTRY, useValue: deps.toolRegistry },
    { provide: APPROVALS, useValue: deps.approvals },
    {
      provide: APPS,
      useFactory: (
        db: KernelDb,
        registry: ToolRegistry,
        credentials: Credentials,
        config: () => KernelConfig,
      ) => new AppsService(db, registry, deps.host, credentials, config, deps.log),
      inject: [KERNEL_DB, TOOL_REGISTRY, CREDENTIALS, KERNEL_CONFIG],
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
