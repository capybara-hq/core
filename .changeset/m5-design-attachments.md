---
"@capybara-hq/design": minor
---

新增对话附件组件（spec §6.9）：

- `AttachmentChip`：输入框里待发送的上传文件（名称、大小、上传进度条、错误、移除）。
- `FileDrop`：拖放 / 粘贴区域（拖入文件时显示覆盖层，粘贴含文件时交给 `onFiles`）。
- `FileButton`：选文件按钮（隐藏的 file input）。
- `AttachmentPreview`：消息里的附件（图片缩略图 / 文件卡片），地址只认 http(s) 与本源绝对路径。
- 工具函数 `formatBytes`、`isSafeAttachmentHref`。
