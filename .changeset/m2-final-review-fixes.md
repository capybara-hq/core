---
"@capybara-hq/kernel": patch
"@capybara-hq/plugin-sdk": patch
"@capybara-hq/plugin-anthropic": patch
"@capybara-hq/plugin-openai": patch
"@capybara-hq/testing": patch
---

M2 终审修复：运行结束后的 ensureRun 失败时退避重试（200ms / 1s / 3s），编排出错的运行之后也 ensureRun；打开 SSE、读事件时不阻塞地 ensureRun，停在「运行中」的孤儿运行由此被清理；abort 孤儿运行时直接写 `run_aborted`；agent 已软删除的会话不再起运行；运行到达终态（含孤儿清理、任务失败）后删除其 checkpoint thread；新迁移 `0009_runs_active_unique` 保证同一会话至多一个未结束的运行。plugin-sdk：text 内容块可带 `opaque`（向后兼容的可选字段）。openai：text 块保存 message 输出项 id，推理项之后按原 id 回放 message 输出项；收到 `response.completed` / `response.incomplete` 后停止读流。anthropic：收到 `message_stop` 后停止读流；用顶层自动 `cache_control` 缓存历史；只对支持 adaptive 思考的模型发 `thinking`，`effort` 能力按 Models API 报告；`listModels` 跳过取不到的模型。测试工具：假模型服务的 SSE 响应可 `keepOpen`。
