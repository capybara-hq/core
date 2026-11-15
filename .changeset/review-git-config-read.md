---
"@capybara-hq/kernel": patch
---

The command review no longer asks for reading the global git config: `git config --global --get…`,
`--list` and the `get` / `list` subcommands are plain git commands, as `git config --list` already
was. Setting, unsetting, editing or renaming in the global or system config still asks
(`ask.shell-config`).
