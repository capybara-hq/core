---
"@capybara-hq/plugin-sdk": minor
"@capybara-hq/kernel": minor
---

Add `ctx.hooks`: plugins register observe or policy hooks on `model.request`, `model.response`,
`tool.preExecute`, `tool.postExecute` and `usage.report` (declared in `permissions.hooks`). Hooks live
on the plugin instance (revoked through its ledger); the kernel `HookRegistry` resolves them from the
active instances only and runs every call through the instance's in-flight tracker, so upgrades fire
one generation and drain the old one. Policy hooks run serially by plugin name (first deny wins;
errors and timeouts deny with a generic model-visible reason); observe hooks are fire-and-forget,
capped at 64 in flight per plugin per replica. New config `hooks.timeoutMs` (hot, default 5000).
