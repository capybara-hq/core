---
"@capybara-hq/kernel": minor
---

由日志快照还原模型请求（M6 T2，D2、C3、C5）：

- `evals/snapshot.ts`：`takeSnapshot(db, orgId, conversationId, runId, maxBytes)` 复制截至该运行终态的事件、引用的
  agent 版本定义与请求用到的工具定义（按 specHash）；运行未到终态 → `eval.run_not_finished`（409），序列化后超过
  `maxBytes` → `eval.case_too_large`（413）。`replayableCalls`（每步最后一次尝试，含收尾调用）、`toEvents`。
- `evals/reconstruct.ts`：`reconstructRequest(snapshot, modelCallSeq, opts)` 按记录的 `absorbedUpToSeq` / `params` /
  `toolChoice` / `maxOutputTokens` 与快照里的工具定义还原请求，基线零漂移；不一致时给出 `drift`
  （`system_hash`、`tools_changed`、`tool_spec_missing`、`definition_missing`、`legacy_event`、`media_missing`）。
  `snapshotMediaRefs` 给出还原要查的附件。
- `runtime/model-call.ts` 导出 `assembleModelRequest`（构建 + 工具配对守卫 + 输出上限），运行时与还原共用。
