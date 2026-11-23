---
"@capybara-hq/plugin-tools": patch
"@capybara-hq/kernel": patch
---

`capybara-plugin bootstrap --write` pins git entries whose tree is a Claude Code plugin or a
skills-only directory: the version is read by the kernel's `readBootstrapGitPlugin` (newly
exported), the reader the bootstrap import identifies the tree with: `.capybara-plugin/plugin.json`,
else `.claude-plugin/plugin.json`, else the entry's own version (#535). A tree that is another
plugin than the entry names is reported as `bootstrap-extra-path`.
