---
"@capybara-hq/kernel": patch
---

`Grep` and `Glob` no longer walk into `.git` or `node_modules` directories, and on a device that has
ripgrep they also skip what `.gitignore` / `.ignore` / `.rgignore` files ignore, so searching a
repository root finishes instead of timing out. A skipped directory is still searched when it is
passed as `path`.
