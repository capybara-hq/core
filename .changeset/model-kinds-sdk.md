---
"@capybara-hq/plugin-sdk": minor
"@capybara-hq/plugin-tools": minor
"@capybara-hq/kernel": minor
---

Model kinds and display fields on `ModelInfo`, an optional `embed` on `ModelProvider`, `{ orgId, config }` call options, `validateEmbedResult`, and an `embedding` usage purpose whose conversation fields are optional.

`ctx.models.embed` / `describe` for extensions that declare embedding purposes in
`permissions.models` (no longer reserved): the kernel resolves the org's model for the purpose,
splits batches by `maxBatch`, validates results, records a `model_usage` row per call and delivers
it through `usage.report` with purpose `embedding`. Each batch is limited by the new hot config
`models.embedTimeoutMs`; `embed` takes an optional per-call `signal`. `capybara-plugin check` reports `ctx.models`
without `permissions.models` as `perm-models` (was `perm-reserved`).
