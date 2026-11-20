---
"@capybara-hq/device": patch
---

A sandboxed command's `HOME` (and `XDG_CACHE_HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`,
`XDG_STATE_HOME`) is now the device's own home `<dir>/home` instead of its working directory, so
tools no longer write their per-user state (such as a `.pnpm-store/`) into a project's repository.
The directory is kept across commands and writable only inside the command's sandbox; asdf's global
`~/.tool-versions` is linked into it. Escalated calls keep your own environment.
