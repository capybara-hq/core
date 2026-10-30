---
"@capybara-hq/kernel": patch
---

The Claude Code tool-name map written into new skills snapshots is shorter: the tools that share a
name with Claude Code are listed as unchanged. Importing a Claude Code agent maps `tools:` entries to
the new builtin names (`Task` and `Agent` to `Agent`, `AskUserQuestion` and `Agent` are kept).
