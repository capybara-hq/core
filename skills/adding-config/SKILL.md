---
name: adding-config
description: 给内核新增或修改配置项（packages/kernel/src/config/schema.ts 的 KernelConfigSchema）时使用：字段 meta（hot / secret / description）、环境变量名的推导规则、重新生成 docs/config.md。
---

# 加内核配置项

内核配置只有一个来源的定义：`packages/kernel/src/config/schema.ts` 里的 `KernelConfigSchema`（Zod 4）。插件的部署级配置不在这里加，写在插件清单的 `config.deployment`（见 `skills/writing-plugins`）。

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

值按 JSON 解析（数字、布尔、数组、对象都能传，如 `CAPYBARA_PLUGINS='["a","b"]'`），解析不了则当字符串。环境变量优先级**高于**配置文件 / Nacos。

`CAPYBARA_CONFIG_*` 与 `CAPYBARA_NACOS_*` 是配置来源自身的选择（`CAPYBARA_CONFIG_SOURCE=file|nacos`、`CAPYBARA_CONFIG_FILE`、`CAPYBARA_NACOS_SERVER` / `_NAMESPACE` / `_DATA_ID`），**不会**被当成配置项；新字段不要起 `config` 或 `nacos` 这种会撞前缀的顶层名。

## 范围说明

主密钥轮换（`masterKeyPrevious` 的使用流程）不在 M0 范围内；schema 里保留了该字段，但不要在此基础上扩展轮换逻辑。
