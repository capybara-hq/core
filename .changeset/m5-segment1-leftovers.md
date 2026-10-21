---
"@capybara-hq/kernel": patch
"@capybara-hq/plugin-sdk": patch
---

M5 第一段审查的收尾：

- 每次运行的媒体缓存上限改为 `attachments.requestMediaBytes`（原为固定 64 MiB）。
- 供应商拒收媒体后写 `media_excluded` 失败时只记 warn，运行仍以原来的失败码结束。
- `ObjectStore.get` / `PluginStorage.get` 的文档写明：带 `range` 时 `head.size` 仍是整个对象的大小，
  存储忽略 Range 时 body 可能是整个对象。
