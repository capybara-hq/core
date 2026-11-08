---
"@capybara-hq/device": minor
"@capybara-hq/plugin-tools": patch
---

New package `@capybara-hq/device`: the `capybara-device` program with `login`, `logout`, `status`, `start`, `stop`, `drain` and `policy`: the connection to the deployment, operation dispatch, results kept across reconnects, a local command log, and the OS sandbox mode (every command inside `@anthropic-ai/sandbox-runtime`: writes only under the environment directory, secret paths unreadable, network limited to the local policy intersected with the environment's egress). The plugin-tools dependency check can hold a package to the plugin-sdk-only boundary (`deviceDirs`).
