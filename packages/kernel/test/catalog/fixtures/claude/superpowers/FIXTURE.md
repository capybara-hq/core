# superpowers fixture

Files from [obra/superpowers](https://github.com/obra/superpowers) at commit
`2ce8aa15d05bd57213e6f746f953aafb7ded7a8b` (release 7.0.1), copied byte for byte. The fixture
tests the Claude Code plugin reader (`packages/kernel/src/catalog/claude/`) against a real plugin.

Kept (verbatim): `LICENSE`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`,
`hooks/hooks.json`, `hooks/session-start`, `package.json`, `.codex-plugin/plugin.json`,
`skills/using-superpowers/SKILL.md`, `skills/using-superpowers/references/claude-code-tools.md`,
`skills/brainstorming/SKILL.md`, `skills/brainstorming/visual-companion.md`,
`skills/test-driven-development/SKILL.md`, `skills/writing-plans/SKILL.md`. The other eleven
skills, the other harness manifests and every `.js` / `.cjs` file are left out.

Added (not in 7.0.1): `commands/brainstorm.md` and `agents/code-reviewer.md`, taken verbatim from
tag `v5.0.7`, when superpowers still shipped commands and agents, so the translation report has a
command and an agent to list.

License: MIT, Copyright (c) 2025 Jesse Vincent (see `LICENSE`).
