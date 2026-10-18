---
"@capybara-hq/kernel": minor
---

Agent 定义删除 `effort`，新增 `modelParams` 与 `fallbackParams`（标量值的记录，默认 `{}`）。保存时按主模型 / 兜底模型各自的参数声明严格校验（没有兜底时 `fallbackParams` 须为空），不合法返回 400 `validation_failed`，`details` 为 `{ path: "modelParams.<key>" | "fallbackParams.<key>", message }[]`。运行时按所用模型的声明宽松处理：主模型尝试用 `modelParams`、兜底尝试用 `fallbackParams`，丢弃未声明或不再合法的项并补默认值，经 `ModelRequest.params` 传给供应商；`maxOutputTokens` 旋钮覆盖 `runtime.maxOutputTokens`（不超过模型上限）。`model_call.request` 以 `params` 与 `droppedParams`（有丢弃时才写）取代原 `effort` 字段，请求可由日志中的 `params` 还原。更新 agent 时（带 `definition` 的 PATCH）同样按当前声明重新校验参数：插件升级后不再声明某个参数时，仍带着这个旧键的 PATCH 会返回 400 `validation_failed`（`details` 点名 `modelParams.<key>` / `fallbackParams.<key>`），去掉该键后才能保存；运行时则照常丢弃它（记入 `droppedParams`）。`runtime.maxOutputTokens` 的说明改为「agent 未设置 `maxOutputTokens` 时每次模型调用的默认输出上限」。
