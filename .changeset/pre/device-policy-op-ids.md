---
"@capybara-hq/plugin-sdk": minor
"@capybara-hq/device": minor
"@capybara-hq/kernel": patch
---

Device policy ops carry an op id. The device protocol's `policy` op now requires `opId` (non-empty,
no `:`, at most 128 characters); the new `policyStatus` op asks a device what became of an op id
(`applied`, `refused`, `started` or `unknown`, with its policy summary now); a hello may carry
`recentOps`, the outcomes of the latest 100 policy ops; the new feature `policyOpId` announces all
three. `capybara-device` logs each policy op in `policy-ops.json` next to `policy.json` (`started`
before the change, then `applied` or `refused`; the last 100 kept), answers a repeated op id from
that log without applying it again, and reports the log in every hello. The kernel sends its op id
with each `policy` op.

The SDK's hello parser keeps one `recentOps` entry per op id (the last one listed). `capybara-device`
keeps a refusal's message in the log cut to 500 characters, never logs an applied op as refused
when releasing the policy lock fails after the write, and keeps an op the log already says was
applied as applied.
