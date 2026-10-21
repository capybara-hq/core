---
"@capybara-hq/plugin-sdk": minor
"@capybara-hq/kernel": minor
"@capybara-hq/plugin-model-fake": patch
---

对象存储与媒体块的 SDK 契约：新增 `object-store@1`（`OBJECT_STORE_CAPABILITY`、`ObjectStore`、`ObjectHead`，单选、中转）与 `ctx.storage`（`PluginStorage`：每个方法第一个参数是 `orgId`，键限定在 `plugins/<插件名>/<orgId>/` 下），`permissions.storage` 不再是预留项；`model-provider@2` 的 `ContentBlock` 新增 `image` / `document` 块（`MediaSource` 为 `base64` 或 `ref`，插件只会收到 `base64`）、`ModelInfo.capabilities.documents`、`MEDIA_LIMITS` 与 `validateMediaBlock`。内核：事件日志的媒体块只接受 `ref`（字节不进日志，`LogContentBlock`）；`ctx.storage` 按 `permissions.storage` 把关，运行时暂为占位（各方法 reject `storage.unavailable`）。`check:plugin-permissions` 新增规则 `perm-storage`，`perm-reserved` 只剩 `ctx.models`。
