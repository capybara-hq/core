---
"@capybara-hq/design": minor
---

对话时间线与插件视图积木组件（spec §6.9）：`Timeline` / `TimelineItem`、`ThinkingRow`、`ToolCallRow`（默认一行，展开为 IN / OUT，输出截断时「查看全部输出」）、`IoBlock`（超过 12 行折叠）、`Checklist`、`CodeBlock`，以及唯一渲染 iframe 的 `EmbedFrame`（sandbox 固定 `allow-scripts allow-forms`、`referrerpolicy=no-referrer`，只转发本 iframe 的 `message`，`frameRef` 暴露 iframe）。`Tabs` 的标签新增 `badge` 与 `alert`；`TopBar` 新增可选的 `extensions` 下拉（「扩展 ▾」，无菜单项时不显示）。`check:web-ui` 新增规则 `web-ui-iframe`：apps/web 不得直接渲染 iframe。

`ThinkingRow` / `ToolCallRow` 只在展开（面板在 DOM 里）时带 `aria-controls`。
