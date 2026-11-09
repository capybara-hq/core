---
"@capybara-hq/plugin-tools": minor
---

Setup guides v2: `capybara-plugin pack` / `check` ship and validate the Markdown guide documents
`guides/<id>.md` and `guides/<id>.zh.md` with the SDK validator (errors fail; warnings such as a
text variable outside quotes in a yaml block are printed as `plugin-pack-guide` and fail
nothing; plugin check ids must be in the extension's `permissions.setupChecks`). The new
`capybara-plugin guide <id>` command prints a guide rendered for a locale, mode, audience and
variable values. `PackResult` gains `warnings`. The v1 template files are no longer read.
The permission check gains `perm-setup-check`: every `ctx.setup.check(id, …)` id must be listed in
`permissions.setupChecks`.
