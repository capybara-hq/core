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
| `http.port` | `CAPYBARA_HTTP__PORT` | `number` | `8080` | 否 | 否 | HTTP listen port |
| `http.trustProxy` | `CAPYBARA_HTTP__TRUST_PROXY` | `boolean \| number \| array<string>` | `false` | 否 | 否 | Which X-Forwarded-For hops to trust for the client IP (login rate limiting, session records): false (use the socket address), a hop count, or a list of trusted proxy IPs/CIDRs (recommended). true trusts any client-supplied X-Forwarded-For and lets clients spoof their IP. A hop count is only safe when the service is reachable solely through exactly that many proxies |
| `roles` | `CAPYBARA_ROLES` | `array<"api" \| "worker" \| "gateway">` | `["api","worker","gateway"]` | 否 | 否 | Roles this process runs |
| `auth.accessTokenTtlSeconds` | `CAPYBARA_AUTH__ACCESS_TOKEN_TTL_SECONDS` | `number` | `900` | 否 | 否 | Lifetime of web session access tokens in seconds |
| `auth.refreshTokenTtlDays` | `CAPYBARA_AUTH__REFRESH_TOKEN_TTL_DAYS` | `number` | `30` | 否 | 否 | Absolute lifetime of a web session (refresh token) in days; refreshing does not extend it |
| `auth.cookieSecure` | `CAPYBARA_AUTH__COOKIE_SECURE` | `boolean` | `true` | 否 | 否 | Set the Secure attribute on session cookies; set false only for local trials over plain http |
| `auth.setupToken` | `CAPYBARA_AUTH__SETUP_TOKEN` | `string` | 可选 | 否 | 是 | If set, the setup wizard requires this token |
| `runtime.maxSteps` | `CAPYBARA_RUNTIME__MAX_STEPS` | `number` | `50` | 否 | 否 | Maximum model steps per agent run before the final wrap-up |
| `runtime.maxRunSeconds` | `CAPYBARA_RUNTIME__MAX_RUN_SECONDS` | `number` | `900` | 否 | 否 | Maximum wall-clock duration of one agent run in seconds |
| `runtime.streamIdleMs` | `CAPYBARA_RUNTIME__STREAM_IDLE_MS` | `number` | `60000` | 否 | 否 | Default model stream idle watchdog in milliseconds (a model's own streamIdleTimeoutMs takes precedence) |
| `runtime.maxOutputTokens` | `CAPYBARA_RUNTIME__MAX_OUTPUT_TOKENS` | `number` | `16000` | 否 | 否 | Upper bound on output tokens per model call (the model's own limit applies if lower) |
| `runtime.compactionThreshold` | `CAPYBARA_RUNTIME__COMPACTION_THRESHOLD` | `number` | `0.8` | 否 | 否 | Compact the conversation when the estimated input reaches this fraction of the context window |
| `runtime.keepRecentTurns` | `CAPYBARA_RUNTIME__KEEP_RECENT_TURNS` | `number` | `4` | 否 | 否 | Number of recent user turns kept verbatim when compacting |
| `runtime.workerConcurrency` | `CAPYBARA_RUNTIME__WORKER_CONCURRENCY` | `number` | `10` | 否 | 否 | Maximum agent runs executed concurrently by one worker process |
| `runtime.orgConcurrency` | `CAPYBARA_RUNTIME__ORG_CONCURRENCY` | `number` | `10` | 是 | 否 | Maximum agent runs executing concurrently per organization across all replicas |
| `runtime.jobLockMs` | `CAPYBARA_RUNTIME__JOB_LOCK_MS` | `number` | `30000` | 否 | 否 | Lock duration of an agent run job in milliseconds (BullMQ lockDuration), also the TTL of the conversation run lock; a run whose worker stops renewing them is considered stalled after this long and resumes on another worker |
| `runtime.stalledIntervalMs` | `CAPYBARA_RUNTIME__STALLED_INTERVAL_MS` | `number` | `30000` | 否 | 否 | How often workers check for stalled agent run jobs in milliseconds (BullMQ stalledInterval) |
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
