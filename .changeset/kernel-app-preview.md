---
"@capybara-hq/kernel": minor
---

新增应用预览 `POST /api/v1/orgs/:orgId/apps/preview`（`apps.manage`，仅用户主体）：请求体同安装（`connector`、`endpoint`，可选 `auth` / `credential` / `name` / `slug`），什么都不写——用连接器的 `inspect`（有则）返回 `authHints` 与 `operations`，给了 `auth: none`、静态认证带凭据或客户端凭据流带 client 时再列工具，返回 `tools`（key、描述、inputSchema、注解、推导的默认策略、`issue`）与 `issues`；否则 `tools: null`（OAuth 授权码流不列，避免动态注册）。外连失败 502 `app.connect_failed`。

安装 / 刷新 / 预览列工具失败时，连接器抛出的 `ToolError` 消息（按本次注入的凭据打码、截到 500 字符）会带进 `app.connect_failed` 的说明（如「Swagger 2.0 documents are not supported…」），其他错误仍只给错误类名。端点的凭据检查与对非管理员的隐藏从 `url` 扩展到所有顶层 `*Url` 字段（如 `specUrl`、`baseUrl`）。安装与预览两个路由的请求体上限放宽到 6 MiB（可携带 2 MB 的 OpenAPI 文档），其余路由不变。
