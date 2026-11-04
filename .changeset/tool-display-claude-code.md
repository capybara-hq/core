---
"@capybara-hq/kernel": minor
"@capybara-hq/web": minor
---

Tool rows follow the Claude Code display: a builtin by its name (`Bash`, `Read`), a connector or
extension tool as `<display name> [<tool>]` with the declared title as the tooltip, the key
argument cut with `…`, and the expanded detail in `IN` / `OUT` blocks. `GET …/conversations/:id/tools`
returns the parsed local tool name (`tool`) and an extension's plugin display name
(`source.displayName`); approval views carry the extension and its display name; IM approval cards
name the tool `<display name> [<tool>]` (no separate `appName`). Approval, inbox, grants, trajectory,
agent policy and right-panel labels use the same rule; a `Write` that could not be diffed no longer
shows `+0 −0`.
