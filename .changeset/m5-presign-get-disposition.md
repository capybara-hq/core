---
"@capybara-hq/plugin-sdk": minor
"@capybara-hq/plugin-object-store-s3": minor
---

`ObjectStore.presignGet` 与 `PluginStorage.presignGet` 的选项改为 `PresignGetOptions`，新增
`disposition`（`"attachment"` 缺省 / `"inline"`）与 `responseContentType`。S3 插件按
`ResponseContentDisposition`（RFC 6266，`filename*=UTF-8''…` 按 RFC 5987 编码 `'()*`）与
`ResponseContentType` 实现；没有文件名时也给出 `attachment`。
