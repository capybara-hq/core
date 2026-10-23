---
name: adding-config
description: 给内核新增或修改配置项（packages/kernel/src/config/schema.ts 的 KernelConfigSchema）时使用：字段 meta（hot / secret / description）、环境变量名的推导规则、重新生成 docs/config.md。
---

# 加内核配置项

内核配置只有一个来源的定义：`packages/kernel/src/config/schema.ts` 里的 `KernelConfigSchema`（Zod 4）。插件的部署级配置不在这里加，写在插件清单的 `config.deployment`（见 `.agents/skills/writing-plugins`）。

## 步骤

1. 在 `KernelConfigSchema` 加字段，**每个字段都带 `meta`**：

   ```ts
   // schema.ts 里直接用同文件的 meta()
   timeoutMs: z
     .number()
     .int()
     .positive()
     .default(5000)
     .meta(meta({ description: "Upstream request timeout in milliseconds" })),
   ```

   `meta` 字段：
   - `description`（必填）：英文一句话；会进入生成的文档。
   - `secret: true`：敏感值（连接串、密钥、token）。文档不展示其默认值，日志与错误信息不得回显其值。
   - `hot: true`：允许热更新。只给确实能在运行中安全生效的字段（如 `log.level`）；默认不热更，改动需重启。

2. 合理的字段给 `.default(...)`；必填字段不给默认值。嵌套对象沿用现有写法（`z.object({...}).prefault({} as never)` 或 `.default({...})`）。
3. 重新生成配置文档并提交：

   ```bash
   pnpm gen:config-docs      # 写 docs/config.md
   ```

   `pnpm check:config-docs`（含在 `pnpm check` 中）发现 `docs/config.md` 与 schema 不一致会报 `config-docs-stale`；不要手改该文件。
4. 影响发布的改动加 changeset（`pnpm changeset`，kernel 一般是 minor）。

## 环境变量名怎么推导

规则（与 `packages/kernel/src/config/env.ts` 一致）：

- 前缀 `CAPYBARA_`；
- 嵌套层级之间用**双下划线** `__`；
- 每一段 camelCase 转 SNAKE_CASE（大写）：`poolMax` → `POOL_MAX`。

| 配置路径 | 环境变量 |
|---|---|
| `db.url` | `CAPYBARA_DB__URL` |
| `db.poolMax` | `CAPYBARA_DB__POOL_MAX` |
| `http.port` | `CAPYBARA_HTTP__PORT` |
| `masterKey` | `CAPYBARA_MASTER_KEY` |
| `pluginConfig` | `CAPYBARA_PLUGIN_CONFIG` |
| 新增 `upstream.timeoutMs` | `CAPYBARA_UPSTREAM__TIMEOUT_MS` |

值按 JSON 解析（数字、布尔、数组、对象都能传，如 `CAPYBARA_PLUGINS='["a","b"]'`），解析不了则当字符串。环境变量优先级**高于**配置文件 / Nacos。同时设置 `CAPYBARA_X`（标量）与 `CAPYBARA_X__Y`（嵌套）属于冲突，启动时抛 `ConfigError` 并点名两个变量；`CAPYBARA_CONFIG_SOURCE` 为空串按未设置处理。

**整段 JSON 与逐字段不能混用**：`CAPYBARA_X` 即使传的是 JSON 对象（如 `CAPYBARA_DB='{"url":"postgres://..."}'`），只要同时设置了 `CAPYBARA_X__Y`（如 `CAPYBARA_DB__POOL_MAX=5`），同样判冲突、启动失败——不会把两者合并。同一段配置只选一种写法。冲突只看「父子路径」：`CAPYBARA_DB__URL` 与 `CAPYBARA_DB__URL_EXTRA`、`CAPYBARA_LOG` 与 `CAPYBARA_LOGGING__X` 都不冲突；被忽略的 `CAPYBARA_CONFIG_*` / `CAPYBARA_NACOS_*` 先剔除、不参与冲突检测。

`CAPYBARA_CONFIG_*` 与 `CAPYBARA_NACOS_*` 是配置来源自身的选择（`CAPYBARA_CONFIG_SOURCE=file|nacos`、`CAPYBARA_CONFIG_FILE`、`CAPYBARA_NACOS_SERVER` / `_NAMESPACE` / `_DATA_ID`，以及 Nacos 鉴权的 `_USERNAME` / `_PASSWORD` / `_ACCESS_TOKEN`），**不会**被当成配置项；新字段不要起 `config` 或 `nacos` 这种会撞前缀的顶层名。

Nacos 开启鉴权时二选一：`CAPYBARA_NACOS_USERNAME` + `CAPYBARA_NACOS_PASSWORD`（启动时 `POST /nacos/v1/auth/login` 换取 accessToken，用到 `tokenTtl` 的 80% 后或请求收到 403 时重新登录），或 `CAPYBARA_NACOS_ACCESS_TOKEN`（直接使用，不登录）。令牌以 `accessToken` 查询参数随读取与监听请求发送。登录失败启动即失败，错误信息含 server、不含密码；两种方式同时设置、或用户名密码不成对，启动报 `ConfigError`。

## 主密钥轮换

内核用 `createKeyring(masterKey, masterKeyPrevious)` 建密钥环：新包装一律用 `masterKey`，`masterKeyPrevious` 只用于解包旧数据密钥。`rewrapDataKeys(db, keyring)`（从 `@capybara-hq/kernel` 导出，M0 尚无 CLI 子命令）把仍由旧主密钥包装的组织数据密钥改用当前主密钥重新包装，返回处理条数。顺序不能乱：

1. 滚动发布，让**所有副本**都换上新密钥环：`masterKey` = 新钥，`masterKeyPrevious` = `[旧钥]`。
2. 确认没有任何副本还只持有旧钥后，再执行 `rewrapDataKeys`（否则旧副本解不开已被新钥重包的数据密钥）。
3. rewrap 完成后，再一次滚动发布把旧钥从 `masterKeyPrevious` 移除。
