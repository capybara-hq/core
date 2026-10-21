---
"@capybara-hq/kernel": patch
"@capybara-hq/plugin-sandbox-docker": patch
"@capybara-hq/plugin-sandbox-e2b": patch
---

`sandbox.limits.egress` 为 `open` 而当前沙箱插件没打开 `allowOpenEgress` 时：内核启动打 warn；插件 `create`
的拒绝错误改为点名 `pluginConfig."<插件>".allowOpenEgress` 与可选的替代值。
