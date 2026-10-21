---
"@capybara-hq/plugin-todo": minor
---

对话页右侧的「任务」标签：注册对话视图 `tasks`（badge 为「已完成/总数」，主体是 checklist），`todo__write` 写入后调用 `ctx.ui.invalidate` 实时刷新，并给出显示摘要「更新任务清单（N 项）」/「Updated task list (N items)」。`writeHandler` 新增第二个参数 `ui`（`ctx.ui`）。
