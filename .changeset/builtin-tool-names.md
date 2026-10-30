---
"@capybara-hq/plugin-sdk": patch
"@capybara-hq/kernel": patch
"@capybara-hq/web": patch
---

The builtin tools take Claude Code's names: `Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`,
`Deliver`, `Skill`, `SkillWrite`, `AskUserQuestion`, `ReadToolOutput`, `ToolSearch` and `Agent`
(formerly `sandbox_bash` … `sandbox_deliver`, `skill_load`, `skill_write`, `ask_user`,
`read_tool_output`, `tool_search` and `agent`). Every description, error and system text that names
a builtin uses the new names; a request recorded before the rename is rebuilt with the old texts,
so it replays with no drift. Parameters are unchanged.
