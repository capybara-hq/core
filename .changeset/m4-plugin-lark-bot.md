---
"@capybara-hq/plugin-lark": minor
---

新增 Lark（飞书国际版）官方插件 `@capybara-hq/plugin-lark`（机器人部分）：`channel@1` 经 Lark 长连接（官方 SDK
`WSClient`，插件自管重连）收消息事件与卡片回调（内核收下后才确认，拒收时回失败让 Lark 重推）、经 OpenAPI 发消息；
所有消息渲染为交互卡片（JSON 2.0），Markdown 转卡片富文本并转义，模型文本无法 @ 所有人；审批 / 提问 / 连接 /
绑定卡片按 zh / en 渲染，状态变化时经卡片更新接口去掉按钮；群聊回复进以 @ 消息为根的话题；附建应用说明。
