---
"@capybara-hq/kernel": patch
---

A `Read` under a permission profile is recorded as a read: `allow.read` inside the workspace and the
tmp root (never `allow.workspace-write` / `allow.tmp-write`), no write finding for a git hook or a
path outside, and credential and device-file reads state that they read.
