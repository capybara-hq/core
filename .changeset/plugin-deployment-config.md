---
"@capybara-hq/kernel": minor
"@capybara-hq/plugin-sdk": patch
"@capybara-hq/capybara": minor
---

部署级插件配置入 PG（D8 / C10）：新增 `GET / PUT /api/v1/admin/plugins/:name/config`（企业管理员，写操作在事务里锁内复核；`PUT {values: {"<字段点路径>": 值 | null}}`）。非密钥字段存 `plugin_deployment_configs`（迁移 0032），`secret()` 字段各自加密存 `capybara.secrets`（namespace `kernel`、org `_deployment`、键 `plugin-deployment-config:<插件>:<路径>`），响应只给「已设置」，审计 `plugin.deployment_config_updated` 只记路径。优先级：环境变量 > 文件 / Nacos > PG > schema 默认值；启动配置里有的字段只读并显示来源，`PUT` 返回 409 `plugin.config_readonly`。新增 `loadConfigWithSources`、`pluginConfigSources`、`KernelOptions.pluginConfigSources`（`capybara start` 传入）。保存后发布 `kernel.plugin-deployment-config`，各副本重读：只改 hot 字段就地替换（`ctx.config` 改为 getter），改了非 hot 字段重新加载插件实例，不合法保持当前值并告警；周期 reconcile 兜底。部署配置不合法时插件一律待处理（`pending / config`），包括配置声明的插件——内核不再因此启动失败；配好后下一次 reconcile 不重启即加载，依赖它的插件随之加载。`capybara plugins review` 列出部署配置问题（只有路径与说明）。
