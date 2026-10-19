import { z } from "zod";
import { LOG_LEVELS } from "../log.js";

/** 配置字段的元信息：是否可热更新、是否敏感、说明。 */
export interface FieldMeta {
  [key: string]: unknown;
  hot?: boolean;
  secret?: boolean;
  description: string;
}

/**
 * 构造给 Zod 4 `.meta()` 使用的字段元信息。
 * 用法：`z.string().meta(meta({ secret: true, description: "..." }))`。
 */
export function meta(opts: FieldMeta): FieldMeta {
  return { ...opts };
}

/** 校验 base64 主密钥解码后恰为 32 字节。 */
function isValidMasterKey(value: string): boolean {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  return Buffer.from(value, "base64").length === 32;
}

/**
 * 受信任身份源的一项：完整的身份源键 `<插件名>:<租户 id>`（Ruling A19，信任按租户）。
 * 插件名同清单规则（不能是 `local`），租户 id 非空、不含空白；与 identity/external.ts 的身份源键规则一致。
 */
const TRUSTED_SOURCE_RE = /^(?!local:)[a-z0-9][a-z0-9._-]{0,213}:\S{1,256}$/;

/** access token 寿命上限（秒）；会话吊销标记的 TTL 按它计算，与实例当前配置无关。 */
export const ACCESS_TOKEN_TTL_MAX_SECONDS = 3600;

const masterKey = z
  .string()
  .refine(isValidMasterKey, { message: "must be base64 that decodes to exactly 32 bytes" });

export const KernelConfigSchema = z.object({
  db: z
    .object({
      url: z
        .string()
        .min(1)
        .meta(meta({ secret: true, description: "PostgreSQL connection URL" })),
      poolMax: z
        .number()
        .int()
        .positive()
        .default(10)
        .meta(meta({ description: "Maximum PostgreSQL pool size" })),
      connectTimeoutMs: z
        .number()
        .int()
        .positive()
        .default(5000)
        .meta(meta({ description: "PostgreSQL connect timeout in milliseconds" })),
    })
    .prefault({} as never),
  redis: z
    .object({
      url: z
        .string()
        .min(1)
        .meta(meta({ secret: true, description: "Redis connection URL" })),
    })
    .prefault({} as never),
  masterKey: masterKey.meta(
    meta({ secret: true, description: "Base64 master key (32 bytes) for secret encryption" }),
  ),
  masterKeyPrevious: z
    .array(masterKey)
    .default([])
    .meta(meta({ secret: true, description: "Previous master keys kept during rotation" })),
  plugins: z
    .array(z.string())
    .default([])
    .meta(meta({ description: "Plugin names to load" })),
  pluginConfig: z
    .record(z.string(), z.unknown())
    .default({})
    .meta(meta({ description: "Deployment-level config keyed by plugin name" })),
  pluginPermissions: z
    .object({
      autoApprove: z
        .boolean()
        .default(false)
        .meta(
          meta({
            description:
              "Approve plugin permissions automatically at startup (development and trials only). When false, a plugin that is new or whose upgrade asks for more permissions is not loaded until an admin runs `capybara plugins approve <name>`",
          }),
        ),
    })
    .default({ autoApprove: false }),
  http: z
    .object({
      port: z
        .number()
        .int()
        .min(0)
        .max(65535)
        .default(8080)
        .meta(meta({ description: "HTTP listen port" })),
      trustProxy: z
        .union([z.boolean(), z.number().int().min(1), z.array(z.string().min(1)).min(1)])
        .default(false)
        .meta(
          meta({
            description:
              "Which X-Forwarded-For hops to trust for the client IP (login rate limiting, session records): false (use the socket address), a hop count, or a list of trusted proxy IPs/CIDRs (recommended). true trusts any client-supplied X-Forwarded-For and lets clients spoof their IP. A hop count is only safe when the service is reachable solely through exactly that many proxies",
          }),
        ),
      // 环境变量按 JSON 解析，CAPYBARA_HTTP__REPLICA_ID=0 会得到数字，所以也接受非负整数（输出头时转字符串）
      replicaId: z
        .union([
          z
            .string()
            .min(1)
            .max(64)
            .regex(/^[A-Za-z0-9._-]+$/),
          z.number().int().nonnegative(),
        ])
        .optional()
        .meta(
          meta({
            description:
              "Optional replica identifier; when set, every HTTP response carries an x-capybara-replica header with this value (used by the dual-replica test harness and for debugging load balancers)",
          }),
        ),
      publicUrl: z
        .url()
        .optional()
        .meta(
          meta({
            description:
              "Externally reachable origin of the web app (apps/web, which proxies /api to the kernel), not the kernel's own address; required for OAuth apps: the redirect URI is <publicUrl>/api/v1/oauth/callback (served through the web /api proxy, which also carries the OAuth binding cookie) and the callback redirects to web pages under it, e.g. https://capybara.example.com",
          }),
        ),
    })
    .default({ port: 8080, trustProxy: false }),
  roles: z
    .array(z.enum(["api", "worker", "gateway"]))
    .default(["api", "worker", "gateway"])
    .meta(meta({ description: "Roles this process runs" })),
  auth: z
    .object({
      accessTokenTtlSeconds: z
        .number()
        .int()
        .min(60)
        .max(ACCESS_TOKEN_TTL_MAX_SECONDS)
        .default(900)
        .meta(meta({ description: "Lifetime of web session access tokens in seconds" })),
      refreshTokenTtlDays: z
        .number()
        .int()
        .min(1)
        .max(365)
        .default(30)
        .meta(
          meta({
            description:
              "Absolute lifetime of a web session (refresh token) in days; refreshing does not extend it",
          }),
        ),
      cookieSecure: z
        .boolean()
        .default(true)
        .meta(
          meta({
            description:
              "Set the Secure attribute on session cookies; set false only for local trials over plain http",
          }),
        ),
      setupToken: z
        .string()
        .min(1)
        .optional()
        .meta(meta({ secret: true, description: "If set, the setup wizard requires this token" })),
      loginSources: z
        .array(z.string().min(1).max(214))
        .max(50)
        .default([])
        .meta(
          meta({
            hot: true,
            description:
              "Plugin names (providing identity-source@1) offered as third-party sign-in on the login page, in this order; the sign-in callback URL is <http.publicUrl>/api/v1/auth/sso/<plugin>/callback",
          }),
        ),
      trustedIdentitySources: z
        .array(
          z
            .string()
            .max(471)
            .refine((v) => TRUSTED_SOURCE_RE.test(v), {
              message:
                'Each entry must be a full identity source key "<plugin>:<tenantId>" (for example "lark:tenant_1"); plugin-only entries are not allowed, trust is per tenant',
            }),
        )
        .max(50)
        .default([])
        .meta(
          meta({
            hot: true,
            description:
              'Identity source keys "<plugin>:<tenantId>" (one tenant each, e.g. "lark:tenant_1") whose external identities are trusted: on third-party sign-in, when the identity\'s email and an existing account\'s email are both verified and equal, the identity is linked to that account instead of creating a new one; accounts created through a trusted source count as email-verified; and members added by directory sync from a trusted source can sign in with that source directly. Only list tenants (workspaces / apps) that your enterprise controls; otherwise anyone in that tenant could claim your users\' emails. Plugin-only entries are rejected',
          }),
        ),
    })
    .default({
      accessTokenTtlSeconds: 900,
      refreshTokenTtlDays: 30,
      cookieSecure: true,
      loginSources: [],
      trustedIdentitySources: [],
    }),
  runtime: z
    .object({
      maxSteps: z
        .number()
        .int()
        .positive()
        .default(50)
        .meta(meta({ description: "Maximum model steps per agent run before the final wrap-up" })),
      maxRunSeconds: z
        .number()
        .int()
        .positive()
        .default(900)
        .meta(meta({ description: "Maximum wall-clock duration of one agent run in seconds" })),
      streamIdleMs: z
        .number()
        .int()
        .positive()
        .default(60000)
        .meta(
          meta({
            description:
              "Default model stream idle watchdog in milliseconds (a model's own streamIdleTimeoutMs takes precedence)",
          }),
        ),
      maxOutputTokens: z
        .number()
        .int()
        .positive()
        .default(16000)
        .meta(
          meta({
            description:
              "Default output-token limit per model call when the agent does not set maxOutputTokens (an agent's maxOutputTokens overrides it; either is capped by the model's own maximum)",
          }),
        ),
      compactionThreshold: z
        .number()
        .gt(0)
        .max(1)
        .default(0.8)
        .meta(
          meta({
            description:
              "Compact the conversation when the estimated input reaches this fraction of the context window",
          }),
        ),
      keepRecentTurns: z
        .number()
        .int()
        .nonnegative()
        .default(4)
        .meta(meta({ description: "Number of recent user turns kept verbatim when compacting" })),
      workerConcurrency: z
        .number()
        .int()
        .positive()
        .default(10)
        .meta(
          meta({ description: "Maximum agent runs executed concurrently by one worker process" }),
        ),
      orgConcurrency: z
        .number()
        .int()
        .positive()
        .default(10)
        .meta(
          meta({
            hot: true,
            description:
              "Maximum agent runs executing concurrently per organization across all replicas",
          }),
        ),
      jobLockMs: z
        .number()
        .int()
        .positive()
        .default(30000)
        .meta(
          meta({
            description:
              "Lock duration of an agent run job in milliseconds (BullMQ lockDuration), also the TTL of the conversation run lock; a run whose worker stops renewing them is considered stalled after this long and resumes on another worker",
          }),
        ),
      stalledIntervalMs: z
        .number()
        .int()
        .positive()
        .default(30000)
        .meta(
          meta({
            description:
              "How often workers check for stalled agent run jobs in milliseconds (BullMQ stalledInterval)",
          }),
        ),
      sseHeartbeatMs: z
        .number()
        .int()
        .positive()
        .default(15000)
        .meta(
          meta({
            description:
              "Interval in milliseconds between heartbeat comments on a conversation event stream (SSE)",
          }),
        ),
      sseRecheckMs: z
        .number()
        .int()
        .positive()
        .default(60000)
        .meta(
          meta({
            description:
              "How often an open conversation event stream (SSE) re-checks that the viewer may still access the conversation, in milliseconds; the stream closes when access is lost",
          }),
        ),
    })
    .default({
      maxSteps: 50,
      maxRunSeconds: 900,
      streamIdleMs: 60000,
      maxOutputTokens: 16000,
      compactionThreshold: 0.8,
      keepRecentTurns: 4,
      workerConcurrency: 10,
      orgConcurrency: 10,
      jobLockMs: 30000,
      stalledIntervalMs: 30000,
      sseHeartbeatMs: 15000,
      sseRecheckMs: 60000,
    }),
  tools: z
    .object({
      timeoutMs: z
        .number()
        .int()
        .positive()
        .default(60000)
        .meta(meta({ description: "Timeout of one tool call in milliseconds" })),
      breakerFailures: z
        .number()
        .int()
        .positive()
        .default(5)
        .meta(
          meta({ description: "Consecutive failures of one app that open its circuit breaker" }),
        ),
      breakerOpenSeconds: z
        .number()
        .int()
        .positive()
        .default(60)
        .meta(
          meta({
            description: "Seconds an open circuit breaker rejects calls before allowing a probe",
          }),
        ),
      outputSpillChars: z
        .number()
        .int()
        .positive()
        .default(50000)
        .meta(
          meta({
            description:
              "Tool results longer than this many characters are archived and replaced by a preview",
          }),
        ),
      outputPreviewChars: z
        .number()
        .int()
        .positive()
        .default(2000)
        .meta(
          meta({
            description:
              "Characters of an archived tool result kept in the conversation as a preview",
          }),
        ),
      outputRetentionDays: z
        .number()
        .int()
        .positive()
        .default(30)
        .meta(meta({ description: "Days archived tool outputs are kept before cleanup" })),
      approvalTimeoutHours: z
        .number()
        .int()
        .positive()
        .default(24)
        .meta(
          meta({
            description:
              "Hours a pending approval or question waits before it expires (treated as denied)",
          }),
        ),
      searchThresholdTools: z
        .number()
        .int()
        .positive()
        .default(30)
        .meta(
          meta({
            description:
              "Switch to on-demand tool search when an agent has more than this many tools",
          }),
        ),
      searchThresholdTokens: z
        .number()
        .int()
        .positive()
        .default(8000)
        .meta(
          meta({
            description:
              "Switch to on-demand tool search when tool definitions exceed this many estimated tokens",
          }),
        ),
      driftIntervalHours: z
        .number()
        .int()
        .positive()
        .default(24)
        .meta(
          meta({
            description: "Hours between checks of connected apps for changed tool definitions",
          }),
        ),
      maxResultReadChars: z
        .number()
        .int()
        .positive()
        .default(20000)
        .meta(meta({ description: "Maximum characters returned by one read_tool_output call" })),
      oauthAllowInsecureLoopback: z
        .boolean()
        .default(false)
        .meta(
          meta({
            description:
              "Allow OAuth discovery, registration and token endpoints over plain http on loopback hosts (development and tests only; production requires https)",
          }),
        ),
    })
    .default({
      timeoutMs: 60000,
      breakerFailures: 5,
      breakerOpenSeconds: 60,
      outputSpillChars: 50000,
      outputPreviewChars: 2000,
      outputRetentionDays: 30,
      approvalTimeoutHours: 24,
      searchThresholdTools: 30,
      searchThresholdTokens: 8000,
      driftIntervalHours: 24,
      maxResultReadChars: 20000,
      oauthAllowInsecureLoopback: false,
    }),
  channels: z
    .object({
      leaseTtlMs: z
        .number()
        .int()
        .positive()
        .default(30000)
        .meta(
          meta({
            description:
              "TTL of the lease that lets one worker replica hold a channel connection's long connection, in milliseconds; another replica takes over after the holder stops renewing it for this long",
          }),
        ),
      scanIntervalMs: z
        .number()
        .int()
        .positive()
        .default(10000)
        .meta(
          meta({
            description:
              "How often each worker replica renews its channel leases and scans for active channel connections that nobody holds, in milliseconds",
          }),
        ),
      retryBaseMs: z
        .number()
        .int()
        .positive()
        .default(5000)
        .meta(
          meta({
            description:
              "First retry delay after a channel long connection fails, in milliseconds; doubles on each consecutive failure up to 5 minutes",
          }),
        ),
      deliveryConcurrency: z
        .number()
        .int()
        .positive()
        .default(100)
        .meta(
          meta({
            description:
              "How many channel outbound delivery jobs one worker replica runs at the same time (each job follows one conversation while its run streams output)",
          }),
        ),
      deliveryIdleMs: z
        .number()
        .int()
        .positive()
        .default(15000)
        .meta(
          meta({
            description:
              "A channel delivery job that has caught up ends after this many milliseconds without new conversation output; the next event of the conversation starts a new job",
          }),
        ),
    })
    // 续租周期必须明显短于 TTL：至少能在租约过期前续两次，偶尔一次 Redis 抖动不至于丢租约
    .refine((c) => c.scanIntervalMs <= c.leaseTtlMs / 2, {
      message: "channels.scanIntervalMs must be at most half of channels.leaseTtlMs",
      path: ["scanIntervalMs"],
    })
    .default({
      leaseTtlMs: 30000,
      scanIntervalMs: 10000,
      retryBaseMs: 5000,
      deliveryConcurrency: 100,
      deliveryIdleMs: 15000,
    }),
  log: z
    .object({
      level: z
        .enum(LOG_LEVELS)
        .default("info")
        .meta(meta({ hot: true, description: "Log level" })),
    })
    .default({ level: "info" }),
});

export type KernelConfig = z.infer<typeof KernelConfigSchema>;
