---
"@capybara-hq/kernel": patch
---

The Claude Code tool-name map written into new skills snapshots is shorter: the tools that share a
name with Claude Code are listed as unchanged. Importing a Claude Code agent maps `tools:` entries to
the new builtin names (`Task` to `Agent`, `MultiEdit` to `Edit`, `TodoWrite` to
`plugin__todo__write`); `mcp__*` entries are still dropped and reported in the translation report.
