import { isIP } from "node:net";
import {
  DOCUMENT_MEDIA_TYPES,
  IMAGE_MEDIA_TYPES,
  validateAllowHost,
} from "@capybara-hq/plugin-sdk";
import { z } from "zod";
import { LOG_LEVELS } from "../log.js";
import { noProxyEntryProblem, proxyUrlProblem } from "../net/proxy.js";
import { privateHostEntryProblem } from "../net/public-address.js";

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

/** `marketplaces.official.url` 的默认值（M7 官方清单上线前为占位地址）。 */
export const MARKETPLACE_OFFICIAL_URL_DEFAULT =
  "https://catalog.capybarahq.com/v1/marketplace.json";
/** 每个清单来源最多的镜像数。 */
export const MARKETPLACE_MAX_MIRRORS = 5;

const masterKey = z
  .string()
  .refine(isValidMasterKey, { message: "must be base64 that decodes to exactly 32 bytes" });

const HOSTNAME_RE =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

/**
 * Why a `marketplaces.allowedHosts` entry is refused, or undefined: a hostname or an IP address
 * (IPv6 without brackets), never a port, scheme or path (entries are compared with the URL's
 * hostname only).
 */
export function allowedHostProblem(entry: string): string | undefined {
  if (isIP(entry) !== 0) return undefined;
  if (entry.startsWith("[")) {
    return `"${entry}": write an IPv6 address without brackets (e.g. ::1)`;
  }
  if (/[/:]/.test(entry)) {
    return `"${entry}": write only the host name, without a scheme, port or path (ports are not compared)`;
  }
  if (!HOSTNAME_RE.test(entry)) return `"${entry}" is not a hostname or an IP address`;
  return undefined;
}

/** proxy-addr's named ranges, which Fastify's trustProxy also accepts. */
const TRUST_PROXY_NAMES = new Set(["loopback", "linklocal", "uniquelocal"]);

/**
 * The IPv4 address carried by an IPv4-mapped IPv6 address (`::ffff:0:0/96`) in any spelling
 * (`::ffff:10.0.0.1`, `::ffff:a00:1`, `0:0:0:0:0:ffff:10.0.0.1`), else undefined. Parsed, not matched
 * as text: proxy-addr unwraps every spelling, so a regex on one spelling lets the others through.
 */
function mappedIpv4(addr: string): string | undefined {
  if (isIP(addr) !== 6) return undefined;
  let s = addr.toLowerCase().split("%")[0] ?? "";
  const dotted = /^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (dotted !== null) {
    const [a = 0, b = 0, c = 0, d = 0] = dotted.slice(2).map(Number);
    s = `${dotted[1]}${(a * 256 + b).toString(16)}:${(c * 256 + d).toString(16)}`;
  }
  const [head = "", tail] = s.split("::");
  const h = head === "" ? [] : head.split(":");
  const t = tail === undefined || tail === "" ? [] : tail.split(":");
  const words =
    tail === undefined ? h : [...h, ...Array<string>(8 - h.length - t.length).fill("0"), ...t];
  if (words.length !== 8) return undefined;
  const n = words.map((w) => Number.parseInt(w, 16));
  if (n.slice(0, 5).some((x) => x !== 0) || n[5] !== 0xffff) return undefined;
  const [hi = 0, lo = 0] = n.slice(6);
  return [hi >> 8, hi & 255, lo >> 8, lo & 255].join(".");
}

/**
 * Why an `http.trustProxy` list entry is refused, or undefined when it is an IP, a CIDR or a named
 * range. A /0 prefix is refused: it trusts every address, so any client could forge the header.
 */
export function trustProxyEntryProblem(entry: string): string | undefined {
  if (TRUST_PROXY_NAMES.has(entry)) return undefined;
  const [addr = "", range, extra] = entry.split("/");
  const family = isIP(addr);
  if (family === 0 || extra !== undefined) return `"${entry}" is not an IP address or CIDR`;
  if (range === undefined) return undefined;
  let bits: number;
  if (/^\d+$/.test(range)) {
    bits = Number(range);
  } else if (family === 4 && isIP(range) === 4) {
    // A dotted netmask (10.0.0.0/255.0.0.0), as proxy-addr accepts: it must be contiguous.
    const mask = range.split(".").reduce((n, o) => n * 256 + Number(o), 0);
    const ones = mask.toString(2).replace(/^0+/, "");
    if (mask !== 0 && (ones.length !== 32 || /01/.test(ones))) {
      return `"${entry}" has a non-contiguous netmask`;
    }
    bits = mask === 0 ? 0 : (ones.match(/1/g) ?? []).length;
  } else {
    return `"${entry}" is not an IP address or CIDR`;
  }
  if (bits > (family === 6 ? 128 : 32)) return `"${entry}" has an out-of-range prefix`;
  // proxy-addr turns an IPv4-mapped IPv6 range (::ffff:a.b.c.d/N, any spelling) into the IPv4
  // range /N-96.
  const mapped = mappedIpv4(addr) !== undefined;
  if (bits === 0 || (mapped && bits === 96)) {
    return `"${entry}" trusts every address; list the proxies' own addresses or CIDRs`;
  }
  // Between /1 and /95 a mapped prefix has no IPv4 equivalent.
  if (mapped && bits < 96) return `"${entry}" has an out-of-range prefix`;
  return undefined;
}

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
  extensions: z
    .array(z.string())
    .default([])
    .meta(meta({ description: "Extension names to load" })),
  extensionConfig: z
    .record(z.string(), z.unknown())
    .default({})
    .meta(meta({ description: "Deployment-level config keyed by extension name" })),
  extensionHost: z
    .object({
      dir: z
        .string()
        .min(1)
        .default("/var/lib/capybara/plugins")
        .meta(
          meta({
            description:
              "Local directory where each replica unpacks installed extension packages (<dir>/<name>/<first 16 hex of sha256>/); safe to wipe, replicas re-download from the package store",
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
              "Seconds in-flight tool calls and queue jobs of an extension being unloaded may keep running before they are aborted",
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
              "Seconds an extension's dispose() may run when it is unloaded or replaced; after that the kernel logs a warning and moves on",
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
              "Seconds an extension's setup() may run when it is reloaded in a running process (enable, upgrade, dependency change), and when an installed extension (install record) is loaded at startup; on timeout the load fails and the previous instance, if any, stays. Built-in and config-declared extensions are not bounded at startup",
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
              "Seconds an installed extension's migrations may run on the replica holding the migration lock; on timeout the migration session is terminated (statement_timeout bounds each statement, lock_timeout bounds lock waits), the lock is released and the replica reports migration_failed (retried on the next reconcile). Built-in and config-declared extensions are not bounded",
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
              "Seconds between periodic reconciles of each replica's loaded extensions against the installed state in PostgreSQL",
          }),
        ),
    })
    .prefault({} as never),
  packages: z
    .object({
      npmRegistry: z
        .url()
        .default("https://registry.npmjs.org")
        .meta(meta({ description: "npm registry used to install extension packages by name" })),
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
              "Largest extension package (.tgz) in bytes accepted by upload, npm install and the PostgreSQL package store. Lowering it also caps what replicas read back from the object store, so packages accepted earlier under a larger limit can no longer be synced. Uploads through the web tier (apps/web) are also capped by its own CAPYBARA_WEB_MAX_PACKAGE_BYTES (default 50 MiB); raise both together",
          }),
        ),
    })
    .prefault({} as never),
  catalog: z
    .object({
      staleInstallMinutes: z
        .number()
        .int()
        .positive()
        .default(30)
        .meta(
          meta({
            description:
              "Minutes after which an organization plugin install still in the installing state (e.g. the replica crashed mid-install) may be cleaned up through uninstall, which rolls back the components it recorded",
          }),
        ),
    })
    .prefault({} as never),
  marketplaces: z
    .object({
      official: z
        .object({
          enabled: z
            .boolean()
            .default(false)
            .meta(
              meta({
                description:
                  "Use the official marketplace. Off by default because the official marketplace is not live yet: while false it is never fetched (no requests, no refresh logs) and the admin UI shows offline mode. Set to true once it is published",
              }),
            ),
          url: z
            .url({ protocol: /^https?$/ })
            .default(MARKETPLACE_OFFICIAL_URL_DEFAULT)
            .meta(
              meta({
                description:
                  "URL of the official marketplace's marketplace.json (https; a placeholder until the official marketplace goes live)",
              }),
            ),
          mirrors: z
            .array(z.url({ protocol: /^https?$/ }))
            .max(MARKETPLACE_MAX_MIRRORS)
            .default([])
            .meta(
              meta({
                description:
                  "Mirror URLs of the official marketplace's marketplace.json (https), tried in order when the main URL fails",
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
              "Minutes between periodic refreshes of every enabled marketplace (one maintenance job for all replicas)",
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
              "Largest marketplace.json in bytes; a larger response is rejected and the previous entries are kept",
          }),
        ),
      allowInsecureLoopback: z
        .boolean()
        .default(false)
        .meta(
          meta({
            description:
              "Testing only: allow plain http for marketplace and tarball URLs on loopback addresses",
          }),
        ),
      allowPrivateHosts: z
        .array(
          z.string().superRefine((entry, ctx) => {
            const problem = privateHostEntryProblem(entry);
            if (problem !== null) ctx.addIssue({ code: "custom", message: problem });
          }),
        )
        .max(100)
        .default([])
        .meta(
          meta({
            description:
              "Hosts or CIDRs that marketplace and git downloads may reach although they resolve to private addresses, e.g. an internal GitLab mirror. CIDR and IP entries match IP-literal hosts only; list internal DNS names as hostnames. Link-local addresses (169.254.0.0/16, fe80::/10) are always refused",
          }),
        ),
      allowedHosts: z
        .array(
          z
            .string()
            .min(1)
            .max(253)
            .superRefine((entry, ctx) => {
              const problem = allowedHostProblem(entry);
              if (problem !== undefined) ctx.addIssue({ code: "custom", message: problem });
            })
            .transform((h) => h.toLowerCase()),
        )
        .max(100)
        .default([])
        .meta(
          meta({
            description:
              "Hosts that marketplace entries may download git and archive sources from: hostnames or IP addresses (IPv6 without brackets), without scheme or port, compared case-insensitively with the URL's hostname. Empty means unrestricted; an entry on another host is listed as not importable and its import is refused",
          }),
        ),
    })
    .prefault({} as never),
  net: z
    .object({
      httpsProxy: z
        .string()
        .superRefine((value, ctx) => {
          const problem = proxyUrlProblem(value);
          if (problem !== undefined) ctx.addIssue({ code: "custom", message: problem });
        })
        .optional()
        .meta(
          meta({
            secret: true,
            description:
              "HTTP(S) egress proxy for marketplace, archive and git downloads, e.g. http://user:password@proxy.internal:3128. https downloads tunnel through it with CONNECT and the kernel no longer resolves their hosts: the proxy does, so blocking private and internal addresses becomes the proxy's job (IP-literal URLs are still checked against marketplaces.allowPrivateHosts). Loopback hosts never use it. Credentials in the URL are sent as Basic Proxy-Authorization and never logged",
          }),
        ),
      noProxy: z
        .array(
          z
            .string()
            .min(1)
            .max(253)
            .superRefine((entry, ctx) => {
              const problem = noProxyEntryProblem(entry);
              if (problem !== undefined) ctx.addIssue({ code: "custom", message: problem });
            }),
        )
        .max(100)
        .default([])
        .meta(
          meta({
            description:
              "Hostnames or IP addresses that bypass net.httpsProxy (an entry also matches its subdomains; a leading dot is allowed). These hosts are resolved locally and must resolve to public addresses unless listed in marketplaces.allowPrivateHosts",
          }),
        ),
    })
    .prefault({} as never),
  extensionPermissions: z
    .object({
      autoApprove: z
        .boolean()
        .default(false)
        .meta(
          meta({
            description:
              "Approve extension permissions automatically at startup (development and trials only). When false, an extension that is new or whose upgrade asks for more permissions is not loaded until an admin runs `capybara extensions approve <name>`",
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
        .preprocess(
          // Also accept a comma-separated string of addresses / CIDRs (an env value that is not JSON
          // arrives as a string, e.g. CAPYBARA_HTTP__TRUST_PROXY=172.18.0.1,10.0.0.0/8).
          (v) =>
            typeof v === "string"
              ? v
                  .split(",")
                  .map((e) => e.trim())
                  .filter((e) => e !== "")
              : v,
          z.union([
            z.boolean(),
            z.number().int().min(1),
            z
              .array(
                z
                  .string()
                  .min(1)
                  .superRefine((e, ctx) => {
                    const problem = trustProxyEntryProblem(e);
                    if (problem !== undefined) ctx.addIssue({ code: "custom", message: problem });
                  }),
              )
              .min(1),
          ]),
        )
        .default(false)
        .meta(
          meta({
            description:
              "Which X-Forwarded-For hops to trust for the client IP (login rate limiting, session records): false (use the socket address), a hop count, or a list of trusted proxy IPs/CIDRs (recommended; a JSON array or a comma-separated string; a /0 prefix is refused). true trusts any client-supplied X-Forwarded-For and lets clients spoof their IP. A hop count is only safe when the service is reachable solely through exactly that many proxies",
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
    .preprocess(
      // Also accept a comma-separated string (CAPYBARA_ROLES=api,worker; env values that are not
      // JSON arrive as strings).
      (v) =>
        typeof v === "string"
          ? v
              .split(",")
              .map((r) => r.trim())
              .filter((r) => r !== "")
          : v,
      z.array(z.enum(["api", "worker", "gateway"])).min(1),
    )
    .default(["api", "worker", "gateway"])
    .meta(
      meta({
        description:
          'Roles this process runs: a JSON array or a comma-separated string, e.g. ["api"] or api,worker',
      }),
    ),
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
        // An empty value means "not set" (compose passes ${CAPYBARA_SETUP_TOKEN:-}). Env values are
        // JSON-parsed, so an all-digit or true / false token arrives as a number or boolean: it is
        // still the token text.
        .preprocess(
          (v) =>
            v === "" ? undefined : typeof v === "number" || typeof v === "boolean" ? String(v) : v,
          z.string().min(1).optional(),
        )
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
              "Extension names (providing identity-source@1) offered as third-party sign-in on the login page, in this order; the sign-in callback URL is <http.publicUrl>/api/v1/auth/sso/<plugin>/callback",
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
              'Identity source keys "<plugin>:<tenantId>" (one tenant each, e.g. "lark:tenant_1") whose external identities are trusted: on third-party sign-in, when the identity\'s email and an existing account\'s email are both verified and equal, the identity is linked to that account instead of creating a new one; and accounts created through a trusted source count as email-verified. Only list tenants (workspaces / apps) that your enterprise controls; otherwise anyone in that tenant could claim your users\' emails. Entries without a tenant id are rejected',
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
      webhookBaseUrl: z
        .url({ protocol: /^https?$/ })
        .optional()
        .meta(
          meta({
            description:
              "Public origin (https) that reaches the gateway replicas, e.g. https://im.example.com; a channel connection's webhook callback URL is <webhookBaseUrl>/channels/webhook/<connection id>. Without it connections cannot switch to webhook inbound (long connections stay the default). Plain http is accepted only for loopback hosts when tools.oauthAllowInsecureLoopback is true (tests)",
          }),
        ),
      webhookMaxBodyBytes: z
        .number()
        .int()
        .positive()
        .default(1_048_576)
        .meta(
          meta({
            description:
              "Largest channel webhook request body in bytes; a larger request is rejected with 413",
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
      webhookMaxBodyBytes: 1_048_576,
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
              "Image for conversation sandboxes, used by the Docker sandbox extension (built from plugins/sandbox-docker/image/Dockerfile; pre-pull it on every Docker node). The E2B extension ignores it and uses its own template setting",
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
  hooks: z
    .object({
      timeoutMs: z
        .number()
        .int()
        .positive()
        .max(60_000)
        .default(5000)
        .meta(
          meta({
            hot: true,
            description:
              "Time limit in milliseconds for one extension hook call; a policy hook that exceeds it denies the call, an observe hook is skipped",
          }),
        ),
      usageReportConcurrency: z
        .number()
        .int()
        .positive()
        .default(16)
        .meta(
          meta({
            description: "usage.report delivery jobs one worker replica processes at the same time",
          }),
        ),
      usageReportKeepHours: z
        .number()
        .int()
        .min(1)
        .max(720)
        .default(24)
        .meta(
          meta({
            description:
              "Hours a finished usage.report job is kept in Redis so re-enqueueing the same usage event (resumed step, sweeper) is deduplicated; at least 1, well above the sweeper's 10-minute overlap",
          }),
        ),
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
