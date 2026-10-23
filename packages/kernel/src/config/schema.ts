import {
  DOCUMENT_MEDIA_TYPES,
  IMAGE_MEDIA_TYPES,
  validateAllowHost,
} from "@capybara-hq/plugin-sdk";
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

/** `runtime.maxRunSeconds` 的默认值。 */
export const DEFAULT_MAX_RUN_SECONDS = 900;
/** `sandbox.limits.maxCommandSeconds` 的默认值。 */
export const DEFAULT_MAX_COMMAND_SECONDS = 7200;

/** access token 寿命上限（秒）；会话吊销标记的 TTL 按它计算，与实例当前配置无关。 */
export const ACCESS_TOKEN_TTL_MAX_SECONDS = 3600;

/** `attachments.requestMediaBytes` 的上限（24 MiB）：base64 后约 32 MiB，是常见供应商的请求上限。 */
export const REQUEST_MEDIA_BYTES_MAX = 25_165_824;

/**
 * 沙箱出站白名单的默认值（`sandbox.limits.allowHosts`）：常用的包仓库与源码托管（git clone、归档下载、
 * raw 文件、release 附件）。不预置 `deb.debian.org`：沙箱用户是 uid 1000、没有 sudo，装不了 apt 包，
 * 放行它只多一个出口；需要系统包的部署把它们装进镜像。组织可以替换这份清单（`sandboxEgress`，Ruling M19）。
 */
export const DEFAULT_SANDBOX_ALLOW_HOSTS = [
  "registry.npmjs.org",
  "pypi.org",
  "files.pythonhosted.org",
  "github.com",
  "codeload.github.com",
  "raw.githubusercontent.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
];

/** `packages.maxBytes` 的默认值（插件包 tgz 的大小上限）；`check:plugin-pack` 用同一个值。 */
export const PACKAGES_MAX_BYTES_DEFAULT = 52_428_800;

/** `catalogs.official.url` 的默认值（M7 官方清单上线前为占位地址）。 */
export const CATALOG_OFFICIAL_URL_DEFAULT = "https://catalog.capybarahq.com/v1/index.json";
/** 每个清单来源最多的镜像数。 */
export const CATALOG_MAX_MIRRORS = 5;

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
  pluginHost: z
    .object({
      dir: z
        .string()
        .min(1)
        .default("/var/lib/capybara/plugins")
        .meta(
          meta({
            description:
              "Local directory where each replica unpacks installed plugin packages (<dir>/<name>/<first 16 hex of sha256>/); safe to wipe, replicas re-download from the package store",
          }),
        ),
      drainSeconds: z
        .number()
        .int()
        .positive()
        .default(30)
        .meta(
          meta({
            description:
              "Seconds in-flight tool calls and queue jobs of a plugin being unloaded may keep running before they are aborted",
          }),
        ),
      disposeTimeoutSeconds: z
        .number()
        .int()
        .positive()
        .default(10)
        .meta(
          meta({
            description:
              "Seconds a plugin's dispose() may run when it is unloaded or replaced; after that the kernel logs a warning and moves on",
          }),
        ),
      reloadSetupTimeoutSeconds: z
        .number()
        .int()
        .positive()
        .default(60)
        .meta(
          meta({
            description:
              "Seconds a plugin's setup() may run when it is reloaded in a running process (enable, upgrade, dependency change), and when an installed plugin (install record) is loaded at startup; on timeout the load fails and the previous instance, if any, stays. Built-in and config-declared plugins are not bounded at startup",
          }),
        ),
      migrationTimeoutSeconds: z
        .number()
        .int()
        .positive()
        .default(300)
        .meta(
          meta({
            description:
              "Seconds an installed plugin's migrations may run on the replica holding the migration lock; on timeout the migration session is terminated (statement_timeout bounds each statement, lock_timeout bounds lock waits), the lock is released and the replica reports migration_failed (retried on the next reconcile). Built-in and config-declared plugins are not bounded",
          }),
        ),
      reconcileIntervalSeconds: z
        .number()
        .int()
        .positive()
        .default(60)
        .meta(
          meta({
            description:
              "Seconds between periodic reconciles of each replica's loaded plugins against the installed state in PostgreSQL",
          }),
        ),
    })
    .prefault({} as never),
  packages: z
    .object({
      npmRegistry: z
        .url()
        .default("https://registry.npmjs.org")
        .meta(meta({ description: "npm registry used to install plugin packages by name" })),
      npmToken: z
        .string()
        .min(1)
        .optional()
        .meta(
          meta({
            secret: true,
            description:
              "Bearer token for the npm registry (private registries); sent only to the registry origin",
          }),
        ),
      maxBytes: z
        .number()
        .int()
        .positive()
        .default(PACKAGES_MAX_BYTES_DEFAULT)
        .meta(
          meta({
            description:
              "Largest plugin package (.tgz) in bytes accepted by upload, npm install and the PostgreSQL package store. Lowering it also caps what replicas read back from the object store, so packages accepted earlier under a larger limit can no longer be synced. Uploads through the web tier (apps/web) are also capped by its own CAPYBARA_WEB_MAX_PACKAGE_BYTES (default 50 MiB); raise both together",
          }),
        ),
    })
    .prefault({} as never),
  directory: z
    .object({
      maxBundleBytes: z
        .number()
        .int()
        .positive()
        .optional()
        .meta(
          meta({
            description:
              "Largest total size in bytes of one app bundle import: the app package plus every plugin package it locks (downloaded and held in memory while validating). Defaults to 4 x packages.maxBytes",
          }),
        ),
      staleInstallMinutes: z
        .number()
        .int()
        .positive()
        .default(30)
        .meta(
          meta({
            description:
              "Minutes after which an organization app install still in the installing state (e.g. the replica crashed mid-install) may be cleaned up through uninstall, which rolls back the components it recorded",
          }),
        ),
    })
    .prefault({} as never),
  catalogs: z
    .object({
      official: z
        .object({
          enabled: z
            .boolean()
            .default(true)
            .meta(
              meta({
                description:
                  "Use the official directory catalog. Set to false for offline deployments: the official catalog is never fetched and the admin UI shows offline mode",
              }),
            ),
          url: z
            .url({ protocol: /^https?$/ })
            .default(CATALOG_OFFICIAL_URL_DEFAULT)
            .meta(
              meta({
                description:
                  "URL of the official catalog index.json (https; a placeholder until the official catalog goes live)",
              }),
            ),
          mirrors: z
            .array(z.url({ protocol: /^https?$/ }))
            .max(CATALOG_MAX_MIRRORS)
            .default([])
            .meta(
              meta({
                description:
                  "Mirror URLs of the official catalog index.json (https), tried in order when the main URL fails",
              }),
            ),
        })
        .prefault({} as never),
      refreshIntervalMinutes: z
        .number()
        .int()
        .min(1)
        .default(360)
        .meta(
          meta({
            description:
              "Minutes between periodic refreshes of every enabled catalog (one maintenance job for all replicas)",
          }),
        ),
      maxIndexBytes: z
        .number()
        .int()
        .positive()
        .default(5_242_880)
        .meta(
          meta({
            description:
              "Largest catalog index.json in bytes; a larger response is rejected and the previous entries are kept",
          }),
        ),
      allowInsecureLoopback: z
        .boolean()
        .default(false)
        .meta(
          meta({
            description:
              "Testing only: allow plain http for catalog and tarball URLs on loopback addresses",
          }),
        ),
    })
    .prefault({} as never),
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
              "Externally reachable origin of the web app (apps/web, which proxies /api to the kernel), not the kernel's own address; required for OAuth connectors: the redirect URI is <publicUrl>/api/v1/oauth/callback (served through the web /api proxy, which also carries the OAuth binding cookie) and the callback redirects to web pages under it, e.g. https://capybara.example.com",
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
              'Identity source keys "<plugin>:<tenantId>" (one tenant each, e.g. "lark:tenant_1") whose external identities are trusted: on third-party sign-in, when the identity\'s email and an existing account\'s email are both verified and equal, the identity is linked to that account instead of creating a new one; and accounts created through a trusted source count as email-verified. Only list tenants (workspaces / apps) that your enterprise controls; otherwise anyone in that tenant could claim your users\' emails. Plugin-only entries are rejected',
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
        .default(DEFAULT_MAX_RUN_SECONDS)
        .meta(
          meta({
            description:
              "Maximum wall-clock duration of one agent run in seconds (time spent waiting for people is not counted). Sandbox commands are limited to the time left in the run, so agents that need long commands need maxRunSeconds >= sandbox.limits.maxCommandSeconds",
          }),
        ),
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
      maxRunSeconds: DEFAULT_MAX_RUN_SECONDS,
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
          meta({
            description: "Consecutive failures of one connector that open its circuit breaker",
          }),
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
            description: "Hours between checks of connectors for changed tool definitions",
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
              "TTL of the lease that lets one gateway replica hold a channel connection's long connection, in milliseconds; another replica takes over after the holder stops renewing it for this long",
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
              "How often each gateway replica renews its channel leases and scans for active channel connections that nobody holds, in milliseconds",
          }),
        ),
      shareSlack: z
        .number()
        .int()
        .nonnegative()
        .default(1)
        .meta(
          meta({
            description:
              "Extra channel long connections a gateway replica may hold above its fair share (connections divided by live gateway replicas); a replica above share + slack hands one back per scan round",
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
      shareSlack: 1,
      retryBaseMs: 5000,
      deliveryConcurrency: 100,
      deliveryIdleMs: 15000,
    }),
  storage: z
    .object({
      purgeDeletedOrgsAfterDays: z
        .number()
        .int()
        .nonnegative()
        .default(30)
        .meta(
          meta({
            description:
              "Days after an organization is deleted before a maintenance job permanently deletes its objects from object storage (kernel/<orgId>/ and plugins/*/<orgId>/)",
          }),
        ),
    })
    .default({ purgeDeletedOrgsAfterDays: 30 }),
  attachments: z
    .object({
      maxBytes: z
        .number()
        .int()
        .positive()
        .default(20_971_520)
        .meta(
          meta({
            description:
              "Maximum size in bytes of one chat attachment (images are also capped at 5 MiB, the model input limit)",
          }),
        ),
      allowedTypes: z
        .array(z.enum([...IMAGE_MEDIA_TYPES, ...DOCUMENT_MEDIA_TYPES]))
        .min(1)
        .default([...IMAGE_MEDIA_TYPES, ...DOCUMENT_MEDIA_TYPES])
        .meta(meta({ description: "Content types accepted for chat attachments" })),
      maxPerMessage: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(10)
        .meta(meta({ description: "Maximum number of attachments in one message" })),
      unboundTtlHours: z
        .number()
        .int()
        .positive()
        .default(24)
        .meta(
          meta({
            description:
              "Hours after upload before an attachment never used in a message is deleted (row and object)",
          }),
        ),
      requestMediaBytes: z
        .number()
        .int()
        .positive()
        // base64 让字节膨胀约 4/3：24 MiB 原始字节 ≈ 32 MiB，正好压在常见供应商 32 MB 的请求上限内
        .max(REQUEST_MEDIA_BYTES_MAX, {
          message: "attachments.requestMediaBytes must be at most 25165824 (24 MiB)",
        })
        .default(20_971_520)
        .meta(
          meta({
            description:
              "Budget of raw attachment bytes in one model request; the newest attachments are kept and older ones are replaced with a placeholder. At most 24 MiB: base64 inflates it by about 4/3, and common providers cap a request at 32 MB",
          }),
        ),
    })
    // 单个附件不能大于单次请求的预算：否则它永远被省略（最新的附件总能放进请求）
    .refine((c) => c.maxBytes <= c.requestMediaBytes, {
      message: "attachments.maxBytes must be at most attachments.requestMediaBytes",
      path: ["maxBytes"],
    })
    .prefault({} as never),
  sandbox: z
    .object({
      image: z
        .string()
        .min(1)
        .default("capybara-sandbox:latest")
        .meta(
          meta({
            description:
              "Image for conversation sandboxes, used by the Docker sandbox plugin (built from plugins/sandbox-docker/image/Dockerfile; pre-pull it on every Docker node). The E2B plugin ignores it and uses its own template setting",
          }),
        ),
      lockWaitSeconds: z
        .number()
        .positive()
        .default(75)
        .meta(
          meta({
            description:
              "Seconds a sandbox call waits while another command in the same conversation holds the sandbox before failing with sandbox.busy; keep it above the 60-second sandbox lock TTL so a call after a replica crash waits for the dead replica's lock to expire",
          }),
        ),
      deliverMaxBytes: z
        .number()
        .int()
        .positive()
        .default(104_857_600)
        .meta(
          meta({
            description:
              "Largest file in bytes an agent may deliver from its sandbox to the user as an artifact (sandbox_deliver)",
          }),
        ),
      limits: z
        .object({
          cpu: z
            .number()
            .positive()
            .default(1)
            .meta(
              meta({
                description:
                  "CPU cores for each sandbox; applies to sandboxes created after the change (E2B: set in the template)",
              }),
            ),
          memoryMb: z
            .number()
            .int()
            .positive()
            .default(2048)
            .meta(
              meta({
                description:
                  "Memory limit of each sandbox in MiB; applies to sandboxes created after the change (E2B: set in the template)",
              }),
            ),
          diskMb: z
            .number()
            .int()
            .positive()
            .default(5120)
            .meta(
              meta({
                description:
                  "Disk limit of each sandbox in MiB; applies to sandboxes created after the change (Docker: only with a volume driver that supports size; E2B: set by the template / plan)",
              }),
            ),
          maxCommandSeconds: z
            .number()
            .int()
            .positive()
            .default(DEFAULT_MAX_COMMAND_SECONDS)
            .meta(
              meta({
                description:
                  "Longest a single sandbox command may run, in seconds. A command also stops when its run is about to reach runtime.maxRunSeconds, so long commands need runtime.maxRunSeconds >= maxCommandSeconds (a startup warning is logged otherwise)",
              }),
            ),
          suspendAfterIdleMinutes: z
            .number()
            .int()
            .positive()
            .default(10)
            .meta(
              meta({
                description:
                  "Minutes without use before a running sandbox is suspended (files are kept)",
              }),
            ),
          destroyAfterInactiveDays: z
            .number()
            .int()
            .positive()
            .default(7)
            .meta(
              meta({
                description:
                  "Days without use before a sandbox is destroyed with its files; the next use starts an empty one",
              }),
            ),
          maxRunningMinutes: z
            .number()
            .int()
            .positive()
            .default(120)
            .meta(
              meta({
                description:
                  "Minutes a sandbox may run continuously before it is suspended even while in use (skipped while a command is running)",
              }),
            ),
          egress: z
            .enum(["none", "allowlist", "open"])
            .default("allowlist")
            .meta(
              meta({
                description:
                  "Outbound network from sandboxes: none, allowlist (only allowHosts) or open; applies to sandboxes created after the change, existing ones keep theirs until destroyed",
              }),
            ),
          allowHosts: z
            .array(z.string())
            .default([...DEFAULT_SANDBOX_ALLOW_HOSTS])
            .superRefine((hosts, ctx) => {
              hosts.forEach((h, i) => {
                for (const message of validateAllowHost(h)) {
                  ctx.addIssue({ code: "custom", path: [i], message: `${h}: ${message}` });
                }
              });
            })
            .meta(
              meta({
                description:
                  "Hosts sandboxes may reach when egress is allowlist: lowercase hostnames, optional leading '*.', no IPs, ports or internal-only names; applies to sandboxes created after the change",
              }),
            ),
        })
        .prefault({} as never),
    })
    .prefault({} as never),
  evals: z
    .object({
      orgConcurrency: z
        .number()
        .int()
        .positive()
        .default(2)
        .meta(
          meta({
            hot: true,
            description:
              "Maximum eval cases executing concurrently per organization across all replicas",
          }),
        ),
      workerConcurrency: z
        .number()
        .int()
        .positive()
        .default(4)
        .meta(meta({ description: "Eval case jobs one replica processes at the same time" })),
      defaultTokenCap: z
        .number()
        .int()
        .positive()
        .default(1_000_000)
        .meta(
          meta({
            description:
              "Token cap of an eval run when none is given; the run stops sending new model requests once it is reached",
          }),
        ),
      maxTokenCap: z
        .number()
        .int()
        .positive()
        .default(20_000_000)
        .meta(meta({ description: "Largest token cap an eval run may ask for" })),
      maxCasesPerSet: z
        .number()
        .int()
        .positive()
        .default(500)
        .meta(meta({ description: "Maximum number of cases in one eval set" })),
      maxCaseBytes: z
        .number()
        .int()
        .positive()
        .default(4_194_304)
        .meta(
          meta({
            description:
              "Largest log snapshot in bytes (serialized JSON) one eval case may store; larger runs cannot be added",
          }),
        ),
      judgeMaxOutputTokens: z
        .number()
        .int()
        .positive()
        .default(1024)
        .meta(meta({ description: "Maximum output tokens of one LLM judge request" })),
      maxConsecutiveErrors: z
        .number()
        .int()
        .positive()
        .default(10)
        .meta(
          meta({
            description:
              "Consecutive failed results after which an eval run is marked failed and its remaining cases are skipped",
          }),
        ),
    })
    // 默认上限必须在允许范围内，否则不传 tokenCap 的运行一律被拒
    .refine((c) => c.defaultTokenCap <= c.maxTokenCap, {
      message: "evals.defaultTokenCap must be at most evals.maxTokenCap",
      path: ["defaultTokenCap"],
    })
    .prefault({} as never),
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
