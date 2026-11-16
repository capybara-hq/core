---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

Add `capybara secrets rewrap`: after a master key rotation it rewraps every org data key and pending
initial password sealed with a key in `masterKeyPrevious` with the current `masterKey`, in batches,
idempotently, printing counts and never a key. The kernel's `rewrapDataKeys` becomes
`rewrapToCurrentMasterKey` (batched, both tables, checks every key in use first) plus
`rewrapMasterKeys` for the CLI. The compose file passes `CAPYBARA_MASTER_KEY_PREVIOUS`, and the
deployment guide has a rotation runbook.
