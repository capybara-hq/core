---
"@capybara-hq/plugin-slack": minor
---

Slack 插件新增 Sign in with Slack（`identity-source@1`，OpenID Connect，jose 校验 ID token）与通讯录
（`directory@1`，`users.list` 分页、排除机器人与 Slackbot、429 按 Retry-After 有限重试）；三处身份键一致
（`slack:<team id>` + Slack user id）。去 @ 时保留换行；卡片截断不再切断转义实体。
