---
"@capybara-hq/kernel": minor
---

评测整轮回放（`mode: "run"`）：在 `kind = 'eval'` 的隐藏对话里跑同一个 LangGraph loop，工具结果只回放原运行记录的
（按工具与规范化参数精确匹配，匹配不上返回英文错误、从不执行工具、沙箱、应用或审批）；插话在原吸收步骤喂入；
每次模型请求都计入 token 预算并在请求前检查取消 / 上限 / 认领；崩溃后删掉旧的评测对话从头重跑。
eval 对话不经会话接口访问，也不会被 `ensureRun` 起真实运行。
回放被停下时 `run_aborted` 记 `reason: "eval_stopped"` 与 `detail`（cancelled / capped / too_many_errors /
claim_lost / shutdown）；删除评测集会取消其在执行的运行并删掉这些运行的评测对话。
