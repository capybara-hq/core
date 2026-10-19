---
"@capybara-hq/kernel": minor
"@capybara-hq/plugin-sdk": patch
"@capybara-hq/plugin-example-counter": patch
"@capybara-hq/plugin-todo": patch
"@capybara-hq/plugin-anthropic": patch
"@capybara-hq/plugin-openai": patch
"@capybara-hq/plugin-openai-compatible": patch
---

- 内核按权限清单构造插件 `ctx`：`kv` / `lock` / `bus` / `queue` / `log` / `db` / `config` / `provide` 自动授予；`secrets` 需 `permissions.secrets`；`http.route` 只允许清单声明的 method + path；`tools.register` 只允许清单声明的工具名。未声明的访问抛 `PluginPermissionError` 并写审计 `plugin.permission_denied`（每个插件每项经 Redis 去重只记一次）。
- 实现 `ctx.capabilities.get / list`：只能取 `requires` / `optional` 中声明的非 brokered 能力；多选能力 `get` 必须指定提供方；传 `orgId` 时返回 Promise，orgScoped 能力按 `plugin_org_configs.enabled` 过滤（不缓存），未启用抛 `CapabilityUnavailableError`。
- `resolvePlugins`：`optional` 缺提供方不报错，存在的提供方参与拓扑排序与环检测。
- plugin-sdk：`permissions.hooks` 只接受总设计 2.4 的挂载点（新增 `HOOK_MOUNT_POINTS`）；`capabilities.get / list` 的类型按是否传 `orgId` 区分同步 / Promise。
- 官方插件补齐权限清单：example-counter 声明路由、todo 声明工具 `write`、anthropic / openai 声明默认访问域名。
