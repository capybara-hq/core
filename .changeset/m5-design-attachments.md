---
"@capybara-hq/design": minor
---

新增对话附件组件（spec §6.9）：

- `AttachmentChip`：输入框里待发送的上传文件（名称、大小、上传进度条、错误、移除）。
- `FileDrop`：拖放 / 粘贴区域（拖入文件时显示覆盖层，粘贴含文件时交给 `onFiles`）。
- `FileButton`：选文件按钮（隐藏的 file input）。
- `AttachmentPreview`：消息里的附件（图片缩略图 / 文件卡片），地址只认 http(s) 与本源绝对路径。
- 工具函数 `formatBytes`、`isSafeAttachmentHref`。

修正：`isSafeAttachmentHref` 拒绝含 ASCII 控制字符、空白或 `\` 的地址，`/` 开头的按占位源解析后源必须不变
（防 `/\t/evil` 被浏览器变成 `//evil`）；`AttachmentChip` 新增 `onRetry`；`AttachmentPreview` 新增
`onImageError`、`retry`（图片地址加缓存参数）与 `onOpen`；`FileDrop` 粘贴时剪贴板有文字则不阻止默认粘贴，
drop / dragend 一律收起覆盖层。
