---
"@capybara-hq/testing": minor
---

双副本工具 `createDualReplicaHarness` 新增 `builtinPlugins` 选项：以 `builtinPlugins` 传给两个副本的内核（来源 `builtin`），
用于验收内置插件（如 object-store-s3）的待配置与免重启加载。
