---
"@capybara-hq/plugin-todo": minor
---

新增 todo 插件 `@capybara-hq/plugin-todo`：注册工具 `write`（模型可见名 `todo__write`，默认策略 allow），参数 `{ todos: [{ content, status, activeForm }] }`，整表覆盖写入本插件 schema 的 `todos` 表（每个会话一行），结果返回清单的文本渲染（`[x]` / `[>]` / `[ ]`）。需在组织里启用该插件后，agent 才能引用 `{ kind: "plugin", plugin: "todo", name: "write" }`。
