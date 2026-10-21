---
"@capybara-hq/kernel": minor
---

评测运行与单步回放：`POST /api/v1/orgs/:orgId/eval-sets/:setId/runs/estimate` 估算请求数、token 与成本，
`POST …/runs` 启动（候选 agent 版本 / 模型 / 参数 / 指令，token 上限 `evals.maxTokenCap` 内），
`/api/v1/orgs/:orgId/eval-runs/:runId`（查看、结果分页、取消），全部 `evals.manage`。运行经队列
`cap-kernel-evals` 每用例一个任务执行，组织并发 `evals.orgConcurrency`，用量达上限即 `capped`；
单步回放由日志还原请求换候选重发。评测集改动与删除用例写审计 `eval.set_updated` / `eval.case_removed`。
