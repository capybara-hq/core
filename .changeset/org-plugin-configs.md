---
"@capybara-hq/plugin-sdk": minor
"@capybara-hq/kernel": minor
---

组织级插件配置存储：`GET /api/v1/orgs/:orgId/plugins`、`PUT /api/v1/orgs/:orgId/plugins/:plugin`（admin+），`Kernel.orgPluginConfigs`（`list` / `put` / `get`）。`config.org` 中 `secret()` 字段单独加密存入 `capybara.secrets`（命名空间 `kernel`），响应只回显是否已设置；更新时密钥字段缺省保留原值、`null` 清除。`PluginHost.manifests()`。plugin-sdk：`definePlugin` 拒绝保留名 `kernel`。
