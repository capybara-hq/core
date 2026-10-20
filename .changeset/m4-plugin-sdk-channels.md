---
"@capybara-hq/plugin-sdk": minor
---

新增 `channel@1`（IM 渠道：连接配置 schema、长连接、发送 / 更新消息、入站事件）、`identity-source@1`（外部登录）与 `directory@1`（通讯录）契约，以及内核定义的渠道中立 IM 卡片规范（审批 / 提问 / 连接 / 绑定）与纯函数 `questionRenderableInline`、`validateChannelCard`、`renderCardAsText`。

`renderCardAsText` 的退回文本是 Markdown：审批标题、输入预览、提问标题与回答摘要（模型可控）放进行内代码或围栏代码块，不再产生链接。
