---
"@capybara-hq/plugin-sdk": patch
---

`parseEmbedChildMessage` 的 `navigate` 更严格：除了单个 `/` 开头，还拒绝任何位置的 `//`、`.` / `..` 路径段
（含任意大小写的 `%2e` 编码），并要求按 URL 规范化后与原文完全相同。
