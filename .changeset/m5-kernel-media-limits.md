---
"@capybara-hq/kernel": minor
---

模型请求里的媒体（M5 修正波 S1，Ruling M8），避免普通输入让会话永久卡住：

- `text/*` 附件在内联与 base64 文档两种方式下都封顶为 50 000 个字符（按码点边界截断并注明）；
  只按范围读开头 150 000 字节，预算按封顶后的大小计。
- 单次请求最多 20 张图片（保留最新的，更早的换成占位）；PDF 页数超过 100 换成占位。
- 新事件 `media_excluded { attachmentIds, reason: "provider_rejected" }`：带媒体字节的请求以不可重试的
  `invalid_request` / `context_overflow` 失败时写入（运行照常失败），之后的请求把这些附件换成「被供应商拒绝」的占位。
- `model_call.request.media` 记下每个附件的处理结果（`bytes` / `inline` / `placeholder_unsupported` /
  `omitted` / `unavailable` / `too_many_pages` / `excluded`，发字节的带 etag）。
- 数不到页数的 PDF 按每 100 KB 一页估算 token（最多 100 页），不再按字节 ÷ 3。
- 同一次运行的各步共用附件字节缓存（进程内 LRU，64 MiB，键含 etag）。
- 压缩记录里的附件名按 `JSON.stringify` 加引号。
