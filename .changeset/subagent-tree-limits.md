---
"@capybara-hq/kernel": minor
"@capybara-hq/web": patch
---

Sub-agent depth, tree budget and per-conversation concurrency (agent map spec §6). New config
`subagents.maxDepth` (1–5, default 3, hot) with an org override `maxDepth` in
`subagentLimitOverrides`; `subagents.maxConcurrentPerRun` is renamed
`subagents.maxConcurrentPerConversation` (config, env var and override key) and counts the active
children of the parent conversation across its runs. Dispatch and token caps count the whole tree on
its budget run (`runs.budget_run_id`, null for a person-triggered run). Migration 0074 adds
`conversations.subagent_depth`, `runs.budget_run_id`, `subagent_dispatches.budget_run_id` and
`subagent_dispatches.for_skill`.
