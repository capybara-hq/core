---
"@capybara-hq/plugin-example-board": minor
---

新插件 example-board：嵌入应用的参考实现，一个最小的工作流进度看板。组织页面 `board` 与对话标签 `board-conv`
都是沙箱 iframe 里的插件页面；数据路由一律先 `ctx.ui.verifyEmbedToken`，`/ui/events`（SSE）按请求订阅
`ctx.bus`、断开或令牌过期即退订，跨副本实时刷新；不用定时器、不放模块级可变状态。
