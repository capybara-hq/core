---
"@capybara-hq/plugin-slack": minor
---

新增 Slack 官方插件 `@capybara-hq/plugin-slack`（机器人部分）：`channel@1` 经 Socket Mode 收事件（内核收下后才 ack）、
经 Web API 发消息；Markdown 转 mrkdwn、超长文本拆分；审批 / 提问 / 连接 / 绑定卡片渲染为 Block Kit（zh / en），
卡片状态变化时经 `chat.update` 去掉按钮；附 Slack 应用 manifest 与建应用说明。

渠道 `verify` 与通讯录一样拒绝组织级安装（`is_enterprise_install`）或企业 id（`E…`）的机器人令牌（租户是工作区）。
