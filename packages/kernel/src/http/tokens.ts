/** 内核 logger（`Logger`）的注入令牌。 */
export const KERNEL_LOG = Symbol("KERNEL_LOG");

/** 健康检查参数（`HealthOptions`）的注入令牌。 */
export const HEALTH_OPTIONS = Symbol("HEALTH_OPTIONS");

/** 内核 schema 视图（`KernelDb`）的注入令牌。 */
export const KERNEL_DB = Symbol("KERNEL_DB");

/** 内核共享 Redis 连接（ioredis `Redis`）的注入令牌。 */
export const KERNEL_REDIS = Symbol("KERNEL_REDIS");

/** 当前配置的取值函数（`() => KernelConfig`，热更新后返回新配置）的注入令牌。 */
export const KERNEL_CONFIG = Symbol("KERNEL_CONFIG");

/** `AccountsService` 的注入令牌。 */
export const ACCOUNTS = Symbol("ACCOUNTS");

/** `SessionService` 的注入令牌。 */
export const SESSIONS = Symbol("SESSIONS");

/** `ApiTokenService` 的注入令牌。 */
export const API_TOKENS = Symbol("API_TOKENS");

/** `SettingsService` 的注入令牌。 */
export const SETTINGS = Symbol("SETTINGS");

/** `LoginRateLimiter` 的注入令牌。 */
export const RATE_LIMITER = Symbol("RATE_LIMITER");

/** `OrgsService` 的注入令牌。 */
export const ORGS = Symbol("ORGS");

/** `MembersService` 的注入令牌。 */
export const MEMBERS = Symbol("MEMBERS");

/** `InvitationsService` 的注入令牌。 */
export const INVITATIONS = Symbol("INVITATIONS");

/** `SetupService` 的注入令牌。 */
export const SETUP = Symbol("SETUP");
