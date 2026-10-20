---
"@capybara-hq/plugin-sdk": minor
---

`Directory` 新增可选方法 `configured?(orgConfig)`：返回 false 时内核视为通讯录未配置，扫描、
`directory_changed` 与移除前复核静默跳过，手动同步返回 409 `directory.not_configured`（Ruling A28）。
