---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

Git pushes through the gateway follow a per-connector policy `git_push` (default ask, migration
0127 `connectors.git_push_policy`). An ask is an approval of kind `git` (`approval_requested.git`,
display only): 「这次允许」 is a run grant, 「这个仓库一直允许」 the member's
`git_push:<host>/<owner>/<repo>` allow. Scheduled tasks accept `git:push` and
`git:push:<owner>/<repo>` grants; an unattended run without one is refused and records the missing
grant.
