---
"@capybara-hq/device": patch
"@capybara-hq/plugin-sdk": patch
---

A native read whose read root is a single file works: the device pins the file's parent directory
and the native helper reaches only that one name through it (macOS and Linux). A kernel read of a
project narrows `AGENTS.md` to itself, and the device refused it with `ENOTDIR`, so a project's
`AGENTS.md` never reached a run.
