---
"@capybara-hq/kernel": minor
---

附件加固（M5 修正波 S1，Ruling M9）：

- 下载只对图片与 PDF 用 `inline`，其余一律 `attachment`；响应类型按 finalize 核对过的类型返回。
  302 带 `Cache-Control: private, max-age=60`（预签名有效 300 秒）。
- 新增 `AttachmentsService.openForConversation(orgId, conversationId, attachmentId)`：只返回绑定在该会话、
  已 ready、大小与 etag 未变的附件流，供沙箱同步使用。
- `GET /attachments/limits` 新增 `requestMediaBytes` 与 `available`（是否配置了对象存储）。
- `POST /attachments`：同一账号在组织里已有 50 个未 finalize 的附件时 429 `attachment.too_many_pending`。
- 配置 `attachments.requestMediaBytes` 不得超过 24 MiB（base64 后约 32 MiB，常见供应商的请求上限）。
