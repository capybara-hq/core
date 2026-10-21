---
"@capybara-hq/kernel": minor
---

附件：新增只读接口 `GET /api/v1/orgs/:orgId/attachments/limits`（`agents.use`），返回
`{ types, maxBytes, imageMaxBytes, maxPerMessage }`（取自 `attachments.*` 配置与 `MEDIA_LIMITS`，不需要对象存储），
供网页上传前预检；发消息时 `attachment.not_found` / `attachment.not_ready` 的 details 带上
`{ path: "files", message, attachmentId }`，网页据此标出对应的附件。
