---
"@capybara-hq/kernel": minor
---

技能库与技能变更的读取接口补齐网页所需（M5 T16）：

- `GET /api/v1/orgs/:orgId/skills/:id` 新增 `body`：当前版本 SKILL.md 的正文（去掉 frontmatter；超过 1MB 或读不到时
  为 null，不让详情失败）。
- 新增 `GET /api/v1/orgs/:orgId/agents/:agentId/skills`：agent 自己写的技能（`scope=agent`），与
  `GET /agents/:agentId` 同一可见性（`agents.use`；看不到的 agent 404 `agent.not_found`）。
- `GET /api/v1/orgs/:orgId/skill-changes/:id` 新增 `current`（改动已有技能时该技能当前生效版本的文件与文本，用于
  显示差异；新技能为 null），列表与收件箱里的技能变更新增 `requestedByName`（发起人的显示名）。
