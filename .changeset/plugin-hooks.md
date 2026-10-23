---
"@capybara-hq/plugin-sdk": minor
"@capybara-hq/kernel": minor
---

Add `ctx.hooks`: plugins register observe or policy hooks on `model.request`, `model.response`,
`tool.preExecute`, `tool.postExecute` and `usage.report` (declared in `permissions.hooks`). The kernel
keeps them in a per-process `HookRegistry`, revoked through the plugin instance ledger on unload,
upgrade and disable. New config `hooks.timeoutMs` (hot, default 5000).
