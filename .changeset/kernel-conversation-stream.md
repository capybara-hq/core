---
"@capybara-hq/kernel": minor
---

新增会话 SSE 流式推送 `GET /api/v1/orgs/:orgId/conversations/:id/stream?after=<seq>`（`agents.use`，仅会话所有者）：先订阅内核总线 `conv.<id>` 再回放事件（`id: <seq>` / `event: event`，按 seq 去重，`Last-Event-ID` 优先于 `after`），转发运行增量（`event: delta`），`: ping` 心跳；连接建立时与长连接期间定期轻量复核可见性，失败即关闭流；停机时关闭本进程的全部流。新增配置 `runtime.sseHeartbeatMs`（默认 15000）与 `runtime.sseRecheckMs`（默认 60000）。
