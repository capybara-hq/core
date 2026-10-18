---
"@capybara-hq/plugin-sdk": minor
---

`Connector` 新增可选方法 `inspect({ endpoint, signal })`，返回 `{ authHints: AuthHint[]; operations?: ConnectorOperation[] }`（不带凭据读端点描述，供安装向导预填认证方式、勾选操作）；新增导出类型 `AuthHint`（映射到内核应用认证的形状：`bearer` / `basic` / `api_key{in,name}` / `oauth_client{tokenUrl,scopes}` / `oauth_code{authorizationUrl,tokenUrl,scopes}`，带 `scheme` 与可选 `description`）、`ConnectorOperation`、`ConnectorInspection`。旧连接器不实现也照常工作。
