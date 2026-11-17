---
"@capybara-hq/plugin-tools": patch
---

`capybara-plugin check` no longer scans the plugin-root `ui/` and `ui-src/` directories in the
plugin state check (plugin-timer, plugin-module-state): a prebuilt embed app and its source are
browser code that runs in one sandboxed iframe document. A deeper `src/ui/` is still server code. A file there that the server bundle reaches is still checked, and the server
bundle is built only for a plugin that has such a directory.
