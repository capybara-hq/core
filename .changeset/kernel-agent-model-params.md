---
"@capybara-hq/kernel": minor
---

Agent 定义删除 `effort`，新增 `modelParams` 与 `fallbackParams`（标量值的记录，默认 `{}`）。保存时按主模型 / 兜底模型各自的参数声明严格校验（没有兜底时 `fallbackParams` 须为空），不合法返回 400 `validation_failed`，`details` 为 `{ path: "modelParams.<key>" | "fallbackParams.<key>", message }[]`。运行时按所用模型的声明宽松处理：主模型尝试用 `modelParams`、兜底尝试用 `fallbackParams`，丢弃未声明或不再合法的项并补默认值，经 `ModelRequest.params` 传给供应商；`maxOutputTokens` 旋钮覆盖 `runtime.maxOutputTokens`（不超过模型上限）。`model_call.request` 以 `params` 与 `droppedParams`（有丢弃时才写）取代原 `effort` 字段，请求可由日志中的 `params` 还原。
