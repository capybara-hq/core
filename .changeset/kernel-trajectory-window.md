---
"@capybara-hq/kernel": minor
---

轨迹接口按运行分页（M6 T7）：

- `GET /api/v1/orgs/:orgId/trajectories/:conversationId` 新增可选的运行窗口：`?runId=` 只取这一次运行；
  `?limit=(1–50)&before=<runId>` 取 `before` 之前（不传为最新）已开始的 `limit` 次运行（只给 `before` 时每页 20），
  按时间正序返回，并带 `next`（更早一页的游标，没有为 null）。只读窗口内运行的事件（从窗口里最早的 `trigger_seq`
  之后读），不再整段读全对话。`runId` 与 `before` / `limit` 同时给 → 400。不带窗口时响应形状不变（没有 `next`）。
  每次 200（含窗口为空）照旧写审计 `trajectory.viewed`。
- `GET /api/v1/orgs/:orgId/trajectories` 新增 `status` 过滤：只列最近一次运行是该状态
  （`queued` / `running` / `waiting` / `completed` / `failed` / `aborted`）的对话。
- `EventLog.readRunsAfter(conversationId, runIds, afterSeq, limit)`：只读指定运行的事件。
