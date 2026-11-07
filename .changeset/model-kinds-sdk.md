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

`ctx.models.embed` fires the `model.request` hook once per call, before anything is sent, so policy
hooks (DLP) see the texts sent to embedding vendors. `ModelRequestHookPayload` is now a union:
`ModelCallRequestHookPayload` (steps, compaction, titles, `WebFetch`; the former interface) or
`EmbeddingRequestHookPayload` (`purpose: "embedding"`, `orgId`, `extension`, `embeddingPurpose`,
`provider`, `model`, `input`, `dimensions?`, `inputType?`, no conversation fields); narrow on
`purpose` before reading `request`. A policy denial rejects the call with `run.hook_denied`, writes
a `hook.denied` audit row and records no usage. `model.response` does not fire for embeddings.
