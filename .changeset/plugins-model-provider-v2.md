---
"@capybara-hq/plugin-anthropic": minor
"@capybara-hq/plugin-openai": minor
"@capybara-hq/plugin-model-fake": minor
"@capybara-hq/kernel": minor
"@capybara-hq/testing": minor
---

`anthropic`、`openai`、`model-fake` 改为提供 `model-provider@2`，不再填 `capabilities.effort`，改在 `parameters` 中声明参数：`anthropic` 按 Models API 声明 `effort`（档位取逐档的 `supported`，没有逐档信息时五档，默认 high）与 `thinking`（`on|summarized`，默认 summarized，`on` 映射为 `display: "omitted"`），模型信息的 kv 缓存键改为 `models:v2:<id>`；`openai` 的推理模型声明五档 `effort`（无默认值）与 `thinking`（`on|summarized`，未设置时沿用部署配置 `reasoningSummary`）；`model-fake` 声明三档 `effort` 与 `model-fake.style`（`plain|shout`，`shout` 时回复转大写）。内核：模型列表缓存键带契约主版本（`capk:models:<provider>:v<主版本>`），插件升级后不再读到旧契约写入的列表；`@1` 适配层补的 effort 旋钮不再带默认值（此前会让未设置 effort 的 agent 静默发送 `high`）。测试工具：一致性套件的 thinking replay 按声明取最高一档 effort 与 thinking `summarized`/`on`、改用需要多步推理的提问，新增导出 `thinkingReplayParams`。
