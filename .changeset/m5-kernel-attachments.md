---
"@capybara-hq/kernel": minor
"@capybara-hq/plugin-sdk": minor
---

对话附件与图片 / 文档作为模型输入。内核：

- 新表 `attachments`（迁移 `0022`）。
- 接口 `POST /api/v1/orgs/:orgId/attachments` 登记附件，返回预签名直传 `{ id, upload: { method, url, headers, fields? }, expiresAt }`。
- `POST .../attachments/:id/finalize` 核对大小、类型与文件签名，然后标记为 ready。
- `GET .../attachments/:id/download` 302 到预签名地址：绑定前只有上传者可下载，绑定后需要能访问其会话。
- 发消息的 body 新增 `files`（ready 附件 id），在同一事务里把附件绑定到该会话，作为 `image` / `document` 引用块写进日志。日志里只有引用，没有字节。
- 新错误码 `attachment.not_found` / `not_ready` / `too_large` / `type_not_allowed`。
- 新配置 `attachments.maxBytes` / `allowedTypes` / `maxPerMessage` / `unboundTtlHours` / `requestMediaBytes`。
- finalize 记下对象 etag 与 PDF 页数；之后内容被替换（etag 或大小不符）时，取字节与下载都按不再可用处理。预签名上传有效 300 秒。
- 维护任务 `attachment-cleanup` 删除过期未绑定的附件，行与对象一并删除。

构建模型请求时把引用解析为 base64：

- 图片看 `vision`，PDF 与文本看 `documents`。
- 模型不支持时只发英文占位，绝不带字节；`text/*` 改为内联截断后的文本。
- 字节已不在时，发「不再可用」占位；存储暂时故障不发占位，本次尝试按可重试错误 `run.storage_unavailable` 失败。
- 单次请求的媒体预算按声明大小从最新往前保留，更早的换成「省略」占位，且不取字节。
- token 估算：图片计 1600，PDF 按页数 × 1000。
- 压缩记录把媒体块记为 `[image: name]` / `[document: name]`。

SDK：`validateMediaBlock` 要求 `attachmentId` 是 UUID，`name` 不超过 255 个字符且不含控制字符；新增导出 `MEDIA_NAME_MAX_CHARS`、`hasControlChars`、`isAttachmentId`。
