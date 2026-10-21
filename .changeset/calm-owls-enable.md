---
"@capybara-hq/kernel": minor
---

组织启用插件时校验依赖：启用时其 `requires` 中按组织启用的能力须已有提供方（否则 `409 plugin.dependency_missing`），停用仍被依赖的唯一提供方返回 `409 plugin.has_dependents`（请求体 `force: true` 可强制）；`GET /api/v1/orgs/:orgId/plugins` 每项新增 `permissions`（按类别分组并标出敏感项）与 `orgConfigSchema`（JSON Schema，密钥字段带 `x-secret`）。
