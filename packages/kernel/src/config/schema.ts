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
    })
    .default({ accessTokenTtlSeconds: 900, refreshTokenTtlDays: 30, cookieSecure: true }),
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
              "Upper bound on output tokens per model call (the model's own limit applies if lower)",
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
