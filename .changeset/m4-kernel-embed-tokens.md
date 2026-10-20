---
"@capybara-hq/kernel": minor
---

插件嵌入应用（界面第二档）：新接口 `POST /api/v1/orgs/:orgId/ui/embeds/:plugin/:id/token`（`{ conversationId? }`
→ `{ token, src, expiresAt, expiresIn }`，`ui.use`、只给人用）签发 300 秒的嵌入令牌：`base64url(声明).base64url(HMAC-SHA256)`，
密钥由主密钥经 HKDF 派生，无头、格式固定；插件须在组织启用、贡献须是 embed，对话嵌入要求能访问该对话（否则 404）。
`ctx.ui.verifyEmbedToken` 实现校验（严格 base64url、常量时间比较、`exp` 容许 30 秒偏差、只认签给本插件的、插件须仍在该组织启用），
内核 `/api` 的鉴权守卫不认这种令牌。`GET .../ui/contributions` 的 embed 项带 `path`。插件路由的 `req.signal`
只在响应写完之前客户端断开时中止（长连接 handler 用来退订）。
