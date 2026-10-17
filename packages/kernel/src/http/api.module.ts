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
import { ProviderRegistry } from "../runtime/providers.js";
import {
  ACCOUNTS,
  AGENTS,
  API_TOKENS,
  INVITATIONS,
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
    {
      provide: PROVIDER_REGISTRY,
      useFactory: (redis: Redis) => new ProviderRegistry(deps.host, redis),
      inject: [KERNEL_REDIS],
    },
    {
      provide: AGENTS,
      useFactory: (db: KernelDb, registry: ProviderRegistry) => new AgentsService(db, registry),
      inject: [KERNEL_DB, PROVIDER_REGISTRY],
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
