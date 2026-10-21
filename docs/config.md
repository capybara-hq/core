# 配置项

<!-- 由 `pnpm gen:config-docs` 生成，请勿手工修改。 -->

配置来源由 `CAPYBARA_CONFIG_SOURCE` 选择（`file` 或 `nacos`）；环境变量优先级最高，
嵌套键用双下划线，例如 `CAPYBARA_DB__URL` 对应 `db.url`。
密钥字段的默认值不会出现在本文档中。

| 配置项 | 环境变量 | 类型 | 默认值 | 可热更 | 密钥 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| `db.url` | `CAPYBARA_DB__URL` | `string` | 必填 | 否 | 是 | PostgreSQL connection URL |
| `db.poolMax` | `CAPYBARA_DB__POOL_MAX` | `number` | `10` | 否 | 否 | Maximum PostgreSQL pool size |
| `db.connectTimeoutMs` | `CAPYBARA_DB__CONNECT_TIMEOUT_MS` | `number` | `5000` | 否 | 否 | PostgreSQL connect timeout in milliseconds |
| `redis.url` | `CAPYBARA_REDIS__URL` | `string` | 必填 | 否 | 是 | Redis connection URL |
| `masterKey` | `CAPYBARA_MASTER_KEY` | `string` | 必填 | 否 | 是 | Base64 master key (32 bytes) for secret encryption |
| `masterKeyPrevious` | `CAPYBARA_MASTER_KEY_PREVIOUS` | `array<string>` | — | 否 | 是 | Previous master keys kept during rotation |
| `plugins` | `CAPYBARA_PLUGINS` | `array<string>` | `[]` | 否 | 否 | Plugin names to load |
| `pluginConfig` | `CAPYBARA_PLUGIN_CONFIG` | `record` | `{}` | 否 | 否 | Deployment-level config keyed by plugin name |
| `pluginPermissions.autoApprove` | `CAPYBARA_PLUGIN_PERMISSIONS__AUTO_APPROVE` | `boolean` | `false` | 否 | 否 | Approve plugin permissions automatically at startup (development and trials only). When false, a plugin that is new or whose upgrade asks for more permissions is not loaded until an admin runs `capybara plugins approve <name>` |
| `http.port` | `CAPYBARA_HTTP__PORT` | `number` | `8080` | 否 | 否 | HTTP listen port |
| `http.trustProxy` | `CAPYBARA_HTTP__TRUST_PROXY` | `boolean \| number \| array<string>` | `false` | 否 | 否 | Which X-Forwarded-For hops to trust for the client IP (login rate limiting, session records): false (use the socket address), a hop count, or a list of trusted proxy IPs/CIDRs (recommended). true trusts any client-supplied X-Forwarded-For and lets clients spoof their IP. A hop count is only safe when the service is reachable solely through exactly that many proxies |
| `http.replicaId` | `CAPYBARA_HTTP__REPLICA_ID` | `string \| number` | 可选 | 否 | 否 | Optional replica identifier; when set, every HTTP response carries an x-capybara-replica header with this value (used by the dual-replica test harness and for debugging load balancers) |
| `http.publicUrl` | `CAPYBARA_HTTP__PUBLIC_URL` | `string` | 可选 | 否 | 否 | Externally reachable origin of the web app (apps/web, which proxies /api to the kernel), not the kernel's own address; required for OAuth apps: the redirect URI is <publicUrl>/api/v1/oauth/callback (served through the web /api proxy, which also carries the OAuth binding cookie) and the callback redirects to web pages under it, e.g. https://capybara.example.com |
| `roles` | `CAPYBARA_ROLES` | `array<"api" \| "worker" \| "gateway">` | `["api","worker","gateway"]` | 否 | 否 | Roles this process runs |
| `auth.accessTokenTtlSeconds` | `CAPYBARA_AUTH__ACCESS_TOKEN_TTL_SECONDS` | `number` | `900` | 否 | 否 | Lifetime of web session access tokens in seconds |
| `auth.refreshTokenTtlDays` | `CAPYBARA_AUTH__REFRESH_TOKEN_TTL_DAYS` | `number` | `30` | 否 | 否 | Absolute lifetime of a web session (refresh token) in days; refreshing does not extend it |
| `auth.cookieSecure` | `CAPYBARA_AUTH__COOKIE_SECURE` | `boolean` | `true` | 否 | 否 | Set the Secure attribute on session cookies; set false only for local trials over plain http |
| `auth.setupToken` | `CAPYBARA_AUTH__SETUP_TOKEN` | `string` | 可选 | 否 | 是 | If set, the setup wizard requires this token |
| `auth.loginSources` | `CAPYBARA_AUTH__LOGIN_SOURCES` | `array<string>` | `[]` | 是 | 否 | Plugin names (providing identity-source@1) offered as third-party sign-in on the login page, in this order; the sign-in callback URL is <http.publicUrl>/api/v1/auth/sso/<plugin>/callback |
| `auth.trustedIdentitySources` | `CAPYBARA_AUTH__TRUSTED_IDENTITY_SOURCES` | `array<string>` | `[]` | 是 | 否 | Identity source keys "<plugin>:<tenantId>" (one tenant each, e.g. "lark:tenant_1") whose external identities are trusted: on third-party sign-in, when the identity's email and an existing account's email are both verified and equal, the identity is linked to that account instead of creating a new one; and accounts created through a trusted source count as email-verified. Only list tenants (workspaces / apps) that your enterprise controls; otherwise anyone in that tenant could claim your users' emails. Plugin-only entries are rejected |
| `runtime.maxSteps` | `CAPYBARA_RUNTIME__MAX_STEPS` | `number` | `50` | 否 | 否 | Maximum model steps per agent run before the final wrap-up |
| `runtime.maxRunSeconds` | `CAPYBARA_RUNTIME__MAX_RUN_SECONDS` | `number` | `900` | 否 | 否 | Maximum wall-clock duration of one agent run in seconds (time spent waiting for people is not counted). Sandbox commands are limited to the time left in the run, so agents that need long commands need maxRunSeconds >= sandbox.limits.maxCommandSeconds |
| `runtime.streamIdleMs` | `CAPYBARA_RUNTIME__STREAM_IDLE_MS` | `number` | `60000` | 否 | 否 | Default model stream idle watchdog in milliseconds (a model's own streamIdleTimeoutMs takes precedence) |
| `runtime.maxOutputTokens` | `CAPYBARA_RUNTIME__MAX_OUTPUT_TOKENS` | `number` | `16000` | 否 | 否 | Default output-token limit per model call when the agent does not set maxOutputTokens (an agent's maxOutputTokens overrides it; either is capped by the model's own maximum) |
| `runtime.compactionThreshold` | `CAPYBARA_RUNTIME__COMPACTION_THRESHOLD` | `number` | `0.8` | 否 | 否 | Compact the conversation when the estimated input reaches this fraction of the context window |
| `runtime.keepRecentTurns` | `CAPYBARA_RUNTIME__KEEP_RECENT_TURNS` | `number` | `4` | 否 | 否 | Number of recent user turns kept verbatim when compacting |
| `runtime.workerConcurrency` | `CAPYBARA_RUNTIME__WORKER_CONCURRENCY` | `number` | `10` | 否 | 否 | Maximum agent runs executed concurrently by one worker process |
| `runtime.orgConcurrency` | `CAPYBARA_RUNTIME__ORG_CONCURRENCY` | `number` | `10` | 是 | 否 | Maximum agent runs executing concurrently per organization across all replicas |
| `runtime.jobLockMs` | `CAPYBARA_RUNTIME__JOB_LOCK_MS` | `number` | `30000` | 否 | 否 | Lock duration of an agent run job in milliseconds (BullMQ lockDuration), also the TTL of the conversation run lock; a run whose worker stops renewing them is considered stalled after this long and resumes on another worker |
| `runtime.stalledIntervalMs` | `CAPYBARA_RUNTIME__STALLED_INTERVAL_MS` | `number` | `30000` | 否 | 否 | How often workers check for stalled agent run jobs in milliseconds (BullMQ stalledInterval) |
| `runtime.sseHeartbeatMs` | `CAPYBARA_RUNTIME__SSE_HEARTBEAT_MS` | `number` | `15000` | 否 | 否 | Interval in milliseconds between heartbeat comments on a conversation event stream (SSE) |
| `runtime.sseRecheckMs` | `CAPYBARA_RUNTIME__SSE_RECHECK_MS` | `number` | `60000` | 否 | 否 | How often an open conversation event stream (SSE) re-checks that the viewer may still access the conversation, in milliseconds; the stream closes when access is lost |
| `tools.timeoutMs` | `CAPYBARA_TOOLS__TIMEOUT_MS` | `number` | `60000` | 否 | 否 | Timeout of one tool call in milliseconds |
| `tools.breakerFailures` | `CAPYBARA_TOOLS__BREAKER_FAILURES` | `number` | `5` | 否 | 否 | Consecutive failures of one app that open its circuit breaker |
| `tools.breakerOpenSeconds` | `CAPYBARA_TOOLS__BREAKER_OPEN_SECONDS` | `number` | `60` | 否 | 否 | Seconds an open circuit breaker rejects calls before allowing a probe |
| `tools.outputSpillChars` | `CAPYBARA_TOOLS__OUTPUT_SPILL_CHARS` | `number` | `50000` | 否 | 否 | Tool results longer than this many characters are archived and replaced by a preview |
| `tools.outputPreviewChars` | `CAPYBARA_TOOLS__OUTPUT_PREVIEW_CHARS` | `number` | `2000` | 否 | 否 | Characters of an archived tool result kept in the conversation as a preview |
| `tools.outputRetentionDays` | `CAPYBARA_TOOLS__OUTPUT_RETENTION_DAYS` | `number` | `30` | 否 | 否 | Days archived tool outputs are kept before cleanup |
| `tools.approvalTimeoutHours` | `CAPYBARA_TOOLS__APPROVAL_TIMEOUT_HOURS` | `number` | `24` | 否 | 否 | Hours a pending approval or question waits before it expires (treated as denied) |
| `tools.searchThresholdTools` | `CAPYBARA_TOOLS__SEARCH_THRESHOLD_TOOLS` | `number` | `30` | 否 | 否 | Switch to on-demand tool search when an agent has more than this many tools |
| `tools.searchThresholdTokens` | `CAPYBARA_TOOLS__SEARCH_THRESHOLD_TOKENS` | `number` | `8000` | 否 | 否 | Switch to on-demand tool search when tool definitions exceed this many estimated tokens |
| `tools.driftIntervalHours` | `CAPYBARA_TOOLS__DRIFT_INTERVAL_HOURS` | `number` | `24` | 否 | 否 | Hours between checks of connected apps for changed tool definitions |
| `tools.maxResultReadChars` | `CAPYBARA_TOOLS__MAX_RESULT_READ_CHARS` | `number` | `20000` | 否 | 否 | Maximum characters returned by one read_tool_output call |
| `tools.oauthAllowInsecureLoopback` | `CAPYBARA_TOOLS__OAUTH_ALLOW_INSECURE_LOOPBACK` | `boolean` | `false` | 否 | 否 | Allow OAuth discovery, registration and token endpoints over plain http on loopback hosts (development and tests only; production requires https) |
| `channels.leaseTtlMs` | `CAPYBARA_CHANNELS__LEASE_TTL_MS` | `number` | `30000` | 否 | 否 | TTL of the lease that lets one worker replica hold a channel connection's long connection, in milliseconds; another replica takes over after the holder stops renewing it for this long |
| `channels.scanIntervalMs` | `CAPYBARA_CHANNELS__SCAN_INTERVAL_MS` | `number` | `10000` | 否 | 否 | How often each worker replica renews its channel leases and scans for active channel connections that nobody holds, in milliseconds |
| `channels.retryBaseMs` | `CAPYBARA_CHANNELS__RETRY_BASE_MS` | `number` | `5000` | 否 | 否 | First retry delay after a channel long connection fails, in milliseconds; doubles on each consecutive failure up to 5 minutes |
| `channels.deliveryConcurrency` | `CAPYBARA_CHANNELS__DELIVERY_CONCURRENCY` | `number` | `100` | 否 | 否 | How many channel outbound delivery jobs one worker replica runs at the same time (each job follows one conversation while its run streams output) |
| `channels.deliveryIdleMs` | `CAPYBARA_CHANNELS__DELIVERY_IDLE_MS` | `number` | `15000` | 否 | 否 | A channel delivery job that has caught up ends after this many milliseconds without new conversation output; the next event of the conversation starts a new job |
| `storage.purgeDeletedOrgsAfterDays` | `CAPYBARA_STORAGE__PURGE_DELETED_ORGS_AFTER_DAYS` | `number` | `30` | 否 | 否 | Days after an organization is deleted before a maintenance job permanently deletes its objects from object storage (kernel/<orgId>/ and plugins/*/<orgId>/) |
| `attachments.maxBytes` | `CAPYBARA_ATTACHMENTS__MAX_BYTES` | `number` | `20971520` | 否 | 否 | Maximum size in bytes of one chat attachment (images are also capped at 5 MiB, the model input limit) |
| `attachments.allowedTypes` | `CAPYBARA_ATTACHMENTS__ALLOWED_TYPES` | `array<"image/png" \| "image/jpeg" \| "image/gif" \| "image/webp" \| "application/pdf" \| "text/plain" \| "text/markdown" \| "text/csv">` | `["image/png","image/jpeg","image/gif","image/webp","application/pdf","text/plain","text/markdown","text/csv"]` | 否 | 否 | Content types accepted for chat attachments |
| `attachments.maxPerMessage` | `CAPYBARA_ATTACHMENTS__MAX_PER_MESSAGE` | `number` | `10` | 否 | 否 | Maximum number of attachments in one message |
| `attachments.unboundTtlHours` | `CAPYBARA_ATTACHMENTS__UNBOUND_TTL_HOURS` | `number` | `24` | 否 | 否 | Hours after upload before an attachment never used in a message is deleted (row and object) |
| `attachments.requestMediaBytes` | `CAPYBARA_ATTACHMENTS__REQUEST_MEDIA_BYTES` | `number` | `20971520` | 否 | 否 | Budget of raw attachment bytes in one model request; the newest attachments are kept and older ones are replaced with a placeholder. At most 24 MiB: base64 inflates it by about 4/3, and common providers cap a request at 32 MB |
| `sandbox.image` | `CAPYBARA_SANDBOX__IMAGE` | `string` | `"capybara-sandbox:latest"` | 否 | 否 | Image for conversation sandboxes, used by the Docker sandbox plugin (built from plugins/sandbox-docker/image/Dockerfile; pre-pull it on every Docker node). The E2B plugin ignores it and uses its own template setting |
| `sandbox.lockWaitSeconds` | `CAPYBARA_SANDBOX__LOCK_WAIT_SECONDS` | `number` | `75` | 否 | 否 | Seconds a sandbox call waits while another command in the same conversation holds the sandbox before failing with sandbox.busy; keep it above the 60-second sandbox lock TTL so a call after a replica crash waits for the dead replica's lock to expire |
| `sandbox.deliverMaxBytes` | `CAPYBARA_SANDBOX__DELIVER_MAX_BYTES` | `number` | `104857600` | 否 | 否 | Largest file in bytes an agent may deliver from its sandbox to the user as an artifact (sandbox_deliver) |
| `sandbox.limits.cpu` | `CAPYBARA_SANDBOX__LIMITS__CPU` | `number` | `1` | 否 | 否 | CPU cores for each sandbox; applies to sandboxes created after the change (E2B: set in the template) |
| `sandbox.limits.memoryMb` | `CAPYBARA_SANDBOX__LIMITS__MEMORY_MB` | `number` | `2048` | 否 | 否 | Memory limit of each sandbox in MiB; applies to sandboxes created after the change (E2B: set in the template) |
| `sandbox.limits.diskMb` | `CAPYBARA_SANDBOX__LIMITS__DISK_MB` | `number` | `5120` | 否 | 否 | Disk limit of each sandbox in MiB; applies to sandboxes created after the change (Docker: only with a volume driver that supports size; E2B: set by the template / plan) |
| `sandbox.limits.maxCommandSeconds` | `CAPYBARA_SANDBOX__LIMITS__MAX_COMMAND_SECONDS` | `number` | `7200` | 否 | 否 | Longest a single sandbox command may run, in seconds. A command also stops when its run is about to reach runtime.maxRunSeconds, so long commands need runtime.maxRunSeconds >= maxCommandSeconds (a startup warning is logged otherwise) |
| `sandbox.limits.suspendAfterIdleMinutes` | `CAPYBARA_SANDBOX__LIMITS__SUSPEND_AFTER_IDLE_MINUTES` | `number` | `10` | 否 | 否 | Minutes without use before a running sandbox is suspended (files are kept) |
| `sandbox.limits.destroyAfterInactiveDays` | `CAPYBARA_SANDBOX__LIMITS__DESTROY_AFTER_INACTIVE_DAYS` | `number` | `7` | 否 | 否 | Days without use before a sandbox is destroyed with its files; the next use starts an empty one |
| `sandbox.limits.maxRunningMinutes` | `CAPYBARA_SANDBOX__LIMITS__MAX_RUNNING_MINUTES` | `number` | `120` | 否 | 否 | Minutes a sandbox may run continuously before it is suspended even while in use (skipped while a command is running) |
| `sandbox.limits.egress` | `CAPYBARA_SANDBOX__LIMITS__EGRESS` | `"none" \| "allowlist" \| "open"` | `"allowlist"` | 否 | 否 | Outbound network from sandboxes: none, allowlist (only allowHosts) or open; applies to sandboxes created after the change, existing ones keep theirs until destroyed |
| `sandbox.limits.allowHosts` | `CAPYBARA_SANDBOX__LIMITS__ALLOW_HOSTS` | `array<string>` | `["registry.npmjs.org","pypi.org","files.pythonhosted.org","github.com","codeload.github.com","raw.githubusercontent.com","objects.githubusercontent.com","release-assets.githubusercontent.com"]` | 否 | 否 | Hosts sandboxes may reach when egress is allowlist: lowercase hostnames, optional leading '*.', no IPs, ports or internal-only names; applies to sandboxes created after the change |
| `evals.orgConcurrency` | `CAPYBARA_EVALS__ORG_CONCURRENCY` | `number` | `2` | 是 | 否 | Maximum eval cases executing concurrently per organization across all replicas |
| `evals.workerConcurrency` | `CAPYBARA_EVALS__WORKER_CONCURRENCY` | `number` | `4` | 否 | 否 | Eval case jobs one replica processes at the same time |
| `evals.defaultTokenCap` | `CAPYBARA_EVALS__DEFAULT_TOKEN_CAP` | `number` | `1000000` | 否 | 否 | Token cap of an eval run when none is given; the run stops sending new model requests once it is reached |
| `evals.maxTokenCap` | `CAPYBARA_EVALS__MAX_TOKEN_CAP` | `number` | `20000000` | 否 | 否 | Largest token cap an eval run may ask for |
| `evals.maxCasesPerSet` | `CAPYBARA_EVALS__MAX_CASES_PER_SET` | `number` | `500` | 否 | 否 | Maximum number of cases in one eval set |
| `evals.maxCaseBytes` | `CAPYBARA_EVALS__MAX_CASE_BYTES` | `number` | `4194304` | 否 | 否 | Largest log snapshot in bytes (serialized JSON) one eval case may store; larger runs cannot be added |
| `evals.judgeMaxOutputTokens` | `CAPYBARA_EVALS__JUDGE_MAX_OUTPUT_TOKENS` | `number` | `1024` | 否 | 否 | Maximum output tokens of one LLM judge request |
| `evals.maxConsecutiveErrors` | `CAPYBARA_EVALS__MAX_CONSECUTIVE_ERRORS` | `number` | `10` | 否 | 否 | Consecutive failed results after which an eval run is marked failed and its remaining cases are skipped |
| `log.level` | `CAPYBARA_LOG__LEVEL` | `"debug" \| "info" \| "warn" \| "error"` | `"info"` | 是 | 否 | Log level |

## Nacos 配置来源

`CAPYBARA_CONFIG_SOURCE=nacos` 时由下列环境变量指定 Nacos（它们不是配置项，不能写进配置文件）：

| 环境变量 | 说明 |
| --- | --- |
| `CAPYBARA_NACOS_SERVER` | Nacos 地址（如 `nacos:8848`，缺省协议为 http），必填 |
| `CAPYBARA_NACOS_NAMESPACE` | 命名空间 ID，必填 |
| `CAPYBARA_NACOS_DATA_ID` | 配置的 dataId（YAML），必填；分组固定为 `DEFAULT_GROUP` |
| `CAPYBARA_NACOS_USERNAME` / `CAPYBARA_NACOS_PASSWORD` | Nacos 开启鉴权时的用户名与密码：登录换取 accessToken，用到 `tokenTtl` 的 80% 或收到 403 时重新登录；须成对设置 |
| `CAPYBARA_NACOS_ACCESS_TOKEN` | 直接使用的 accessToken（不调用登录接口）；不能与用户名密码同时设置 |
