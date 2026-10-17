---
"@capybara-hq/kernel": minor
---

运行编排：BullMQ 运行队列（`cap-kernel-runs`）、会话级租约锁、组织并发配额（部署设置 `runConcurrencyOverrides` 按组织覆盖）、跨副本中止（`POST /api/v1/orgs/:orgId/conversations/:id/abort`，无活跃运行时 409 `run.not_active`）、插话吸收、运行生命周期事件与优雅停机（新增 `runs` 停机阶段）；`AgentLoop` 接口与 `KernelOptions.loop`；新增配置 `runtime.jobLockMs`、`runtime.stalledIntervalMs`。
