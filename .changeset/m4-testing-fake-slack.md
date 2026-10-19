---
"@capybara-hq/testing": minor
---

新增 `startFakeSlack`：假 Slack（Web API 的 `auth.test` / `chat.postMessage` / `chat.update` / `users.info` /
`apps.connections.open`，以及推送信封、记录确认的 Socket Mode WebSocket），附 `slackDmEvent`、`slackMentionEvent`、
`slackBlockAction`、`findSlackButton` 构造与查找函数。
