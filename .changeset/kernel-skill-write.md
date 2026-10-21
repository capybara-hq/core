---
"@capybara-hq/kernel": minor
---

agent 自写技能与共享 agent 的技能变更审批（M5 T15，R4）：

- 内置工具 `skill_write {name, description, files:[{path, content}]}`（agent 定义显式引用才可用）：只写 agent 自己的
  技能（`scope=agent`），只收文本、整个技能 ≤ 1MB，SKILL.md 由 name / description 加 `SKILL.md` 一项的正文合成，
  路径按技能包规则校验；每个 agent 最多 50 个自己的技能（含待批准的新技能）。成功后在同一事务里往本对话追加
  技能目录快照，同一运行的下一步即可 `skill_load`。
- 私有 agent：直接生成新版本、立即生效（审计 `skill.created` / `skill.version_created`）。
- 共享 agent：`skill_write` 在 R3 固定 ask 清单上（只对共享 agent，`R3_SHARED_AGENT_ONLY_TOOL_KEYS`），由触发对话的人
  确认后生成变更申请（新表 `skill_change_requests`，迁移 `0026_skill_changes.sql`，审计 `skill.change_requested`）；
  负责人批准前只有发起对话试用新版本，其他对话照旧。同名技能最多一条待处理申请：同一对话再写取代旧的，别的对话
  再写被拒绝。
- `POST /api/v1/orgs/:orgId/skill-changes/:id/decide {decision: approve|reject}`：只有该 agent 当前的负责人能决定
  （其他人 403 `skill_change.not_owner`，服务令牌 403）；批准后新版本对所有对话生效，拒绝后删除草稿。
  `GET /skill-changes/:id` 给负责人与发起人看详情（含文件文本）。审计 `skill.change_decided`。
- 收件箱 `GET /api/v1/orgs/:orgId/inbox`：按类型汇总待处理的工具审批（`tool_approval`）与能决定的技能变更
  （`skill_change`），新的在前、最多 100 项。
- `skill_load` 的沙箱复制标记加上来源前缀：同号的新草稿会重新复制。
- 技能目录条目新增必填 `source`（版本 / 草稿的对象前缀）：同号的草稿与正式版本靠它区分，`skill_load` 只按它解析；
  拒绝 / 取消草稿时给发起对话立即追加回退快照。负责人可删除 agent 自己的技能
  （`DELETE /orgs/:orgId/agents/:agentId/skills/:skillId`）；删除 agent 时取消其待处理的技能改动。
- 运行开始的目录快照在一个事务里先锁会话行再解析、比较、追加；技能改动路径先给组织行加 KEY SHARE 再锁 agent 行
  （与 agent 修改的加锁顺序一致）。删除 agent 技能时看不到 agent 返回 404 `agent.not_found`。
