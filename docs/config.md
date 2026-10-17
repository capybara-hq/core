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
| `http.trustProxy` | `CAPYBARA_HTTP__TRUST_PROXY` | `boolean` | `false` | 否 | 否 | Trust X-Forwarded-For for the client IP (login rate limiting, session records); enable only behind a trusted proxy |
| `roles` | `CAPYBARA_ROLES` | `array<"api" \| "worker" \| "gateway">` | `["api","worker","gateway"]` | 否 | 否 | Roles this process runs |
| `auth.accessTokenTtlSeconds` | `CAPYBARA_AUTH__ACCESS_TOKEN_TTL_SECONDS` | `number` | `900` | 否 | 否 | Lifetime of web session access tokens in seconds |
| `auth.refreshTokenTtlDays` | `CAPYBARA_AUTH__REFRESH_TOKEN_TTL_DAYS` | `number` | `30` | 否 | 否 | Absolute lifetime of a web session (refresh token) in days; refreshing does not extend it |
| `auth.cookieSecure` | `CAPYBARA_AUTH__COOKIE_SECURE` | `boolean` | `true` | 否 | 否 | Set the Secure attribute on session cookies; set false only for local trials over plain http |
| `log.level` | `CAPYBARA_LOG__LEVEL` | `"debug" \| "info" \| "warn" \| "error"` | `"info"` | 是 | 否 | Log level |
