import type { Logger } from "@capybara-hq/plugin-sdk";
import { type DynamicModule, Module, type Provider, type Type } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import type { Redis } from "ioredis";
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
import type { PluginHost } from "../plugins/host.js";
import {
  ACCOUNTS,
  API_TOKENS,
  KERNEL_CONFIG,
  KERNEL_DB,
  KERNEL_REDIS,
  RATE_LIMITER,
  SESSIONS,
  SETTINGS,
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
}

/** 内核 API 的全部 controller；后续任务往这里追加。 */
const CONTROLLERS: Type[] = [AuthController, MeController];

/**
 * 领域服务 provider：领域类保持框架无关（不加装饰器），一律用 `useFactory` 构造。
 * 后续任务往这里追加（ORGS、MEMBERS、INVITATIONS、SETUP、ORG_PLUGIN_CONFIGS、PLUGIN_HOST…）。
 */
function serviceProviders(deps: ApiDeps): Provider[] {
  return [
    { provide: KERNEL_DB, useValue: deps.db },
    { provide: KERNEL_REDIS, useValue: deps.redis },
    { provide: KERNEL_CONFIG, useValue: deps.config },
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
      useFactory: (db: KernelDb) => new SettingsService(db),
      inject: [KERNEL_DB],
    },
    {
      provide: RATE_LIMITER,
      useFactory: (redis: Redis) => new LoginRateLimiter(redis),
      inject: [KERNEL_REDIS],
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
