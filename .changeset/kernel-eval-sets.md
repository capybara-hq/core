---
"@capybara-hq/kernel": minor
---

评测集与用例：组织管理员从某个 agent 的真实对话里挑选或抽样运行加入评测集，每个用例存一份日志快照
（`/api/v1/orgs/:orgId/eval-sets`，`evals.manage`）；对话新增 `kind`（chat / eval），「我的对话」只列 chat，
轨迹列表按 `kind` 过滤（缺省 chat）；新增配置 `evals.*`。
