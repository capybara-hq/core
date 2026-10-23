---
"@capybara-hq/kernel": minor
---

轨迹读模型、模型价格表与轨迹接口（M6 T1，D6、C2）：

- `buildTrajectory(events, prices)`（`evals/trajectory.ts`，纯函数）：由会话事件日志推出每次运行的步骤、模型调用
  （尝试 / 兜底、`ok` / `failed` / `pending`、延迟 = 该步 `usage` − `model_call` 的时间差）、工具调用（`input` 取自
  `tool_call` 块，耗时 = `tool_result` − 最后一次 `tool_call_started`）、审批链与输入请求，以及合计用量与成本。
- 模型价格表：新表 `model_prices`（迁移 `0027_model_prices.sql`，每百万 token；同时为轨迹列表加索引
  `conversations (org_id, agent_id, updated_at DESC)`）。成本读时计算、不写日志；缓存读 / 写价为空时按输入价；
  任一成功调用没有价格时合计成本为 null。部署设置新增 `priceCurrency`（默认 `"USD"`，三位大写币种代码）。
- `GET /api/v1/admin/model-prices → {prices, currency}`、`PUT /api/v1/admin/model-prices`（`ModelPrice`，或
  `{provider, model, price: null}` 删除；单价 0–1e6）：只给企业管理员，写入在企业管理员锁内复核，审计
  `model_price.updated` / `model_price.deleted`。
- `GET /api/v1/orgs/:orgId/trajectories?agentId&kind&before&limit(≤100)`、`GET …/trajectories/:conversationId`：
  新组织动作 `trajectories.read`（member 起、只给人），组织管理员看全部，其余成员只看自己当前负责的 agent（实时读）；
  无权或不存在一律 404 `trajectory.not_found`；每次查看详情写审计 `trajectory.viewed`。`kind` 过滤待评测对话加入后生效，
  目前所有对话都是 `chat`。
