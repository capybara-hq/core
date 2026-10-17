---
"@capybara-hq/kernel": minor
---

新增 Agent 定义、版本与可见范围（迁移 `0005_agents.sql`）：`/api/v1/orgs/:orgId/agents` 增删改查与版本列表、`/api/v1/orgs/:orgId/models` 列出已安装模型供应商（列表缓存在 Redis `capk:models:<provider>`，600 秒）；组织动作新增 `agents.create`（member）与 `agents.use`（guest，服务令牌可用）；错误码 `agent.not_found`、`agent.model_unavailable`。
