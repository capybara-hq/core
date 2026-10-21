---
"@capybara-hq/kernel": minor
---

通讯录同步尊重插件的 `Directory.configured`：未配置的 (组织, 插件) 不扫描、不投递、不审计、不记警告；
手动同步返回 409 `directory.not_configured`（新错误码，网页 zh / en 文案）。`DirectorySync.enqueue`
只用于 `directory_changed`，未配置时返回 undefined。
