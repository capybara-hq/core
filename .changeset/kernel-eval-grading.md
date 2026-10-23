---
"@capybara-hq/kernel": minor
---

评测评分：
- 结构差异：done 的结果写 `diff`（工具调用按名字对齐，参数按规范化 JSON 比较；文本按空白切词的 LCS 比值，
  词数之积超过 4,000,000 时只比是否相等；停止原因是否一致）。
- 模型用途映射（表 `model_purpose_mappings`）：内核用途 `eval` 与插件 `permissions.models` 声明的用途；
  部署默认（`/api/v1/admin/model-purposes`，企业管理员）+ 组织覆盖（`/api/v1/orgs/:orgId/model-purposes`，
  新动作 `org.models.manage`）；未映射 `model.unconfigured`，未声明 `model.purpose_unknown`；审计 `model.purpose_mapped`。
- LLM 评委（用途 `eval`，英文提示词，输出上限 `evals.judgeMaxOutputTokens`）：结论写进 `judge`，用量计入运行的
  token 预算（失败按估算）。
- 人工标注 `PUT /api/v1/orgs/:orgId/eval-results/:resultId/label`（`evals.manage`），审计 `eval.result_labeled`。
- 运行汇总给出 `toolCallsMatchRate` / `meanTextSimilarity` / `judgePassRate` / `humanPassRate`。
