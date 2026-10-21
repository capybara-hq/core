---
"@capybara-hq/testing": minor
---

新增 `startFakeLark`：假 Lark（OpenAPI 的 tenant token / 机器人信息 / 企业信息 / 发送、回复、更新卡片 / 用户资料，
以及按官方 SDK protobuf 帧格式实现、推送事件并记录确认的长连接），附 `larkMessageEvent`、`larkCardAction`、
`findLarkButton` 构造与查找函数。
