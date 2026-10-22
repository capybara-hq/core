---
"@capybara-hq/kernel": minor
---

评测第一段修正：估算含评委份额（`judgeTokens` / `judgeCost`，按 eval 用途模型定价，计入总数），只读用例上写入时
存好的计划列（`plan_step` / `plan_run` / `base_model`），不读快照；删除评测集时硬删用例（结果级联删除）；
结果轻量列表 `GET …/eval-runs/:runId/results?view=light&updatedSince=…`（带 `asOf`）与单条
`GET …/results/:resultId`，查看结果写审计 `eval.results_viewed`（每人每运行每小时一条）；删除组织或 agent 时取消
其评测运行（审计 `eval.run_cancelled`，detail 带原因），`runActive` 同时要求组织与 agent 未删除；评测对话
（`kind=eval`）的轨迹只给组织管理员；未知 `runId` / `before` 的轨迹窗口返回 404；评委输出上限受评委模型上限约束；
单步回放每次请求前复核认领，组织配额成员带认领号；熔断时跳过整个运行待做的评委。
