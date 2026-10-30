---
"@capybara-hq/kernel": patch
---

The builtin tools take Claude Code's parameters: `file_path` (`Read`, `Write`, `Edit`, `Deliver`),
`old_string` / `new_string` / `replace_all` (`Edit`), `timeout` in milliseconds (`Bash`, a value
above the deployment maximum is lowered to it), `skill` (`Skill`), `max_results` (`ToolSearch`)
and, for `Grep`, `-i`, `output_mode` (`files_with_matches` by default, `content`, `count`), `-n`,
`-A` / `-B` / `-C`, `head_limit` and `offset`. Calls recorded under the old names still replay.
