---
"@capybara-hq/device": patch
---

Sandboxed commands no longer read mise's configuration directory (`~/.config/mise`, whose
`config.toml` may hold tokens); a mise-managed tool still runs from its data directory with a
project pin or the global `~/.tool-versions`.
