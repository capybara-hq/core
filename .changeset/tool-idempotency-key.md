---
"@capybara-hq/plugin-sdk": minor
"@capybara-hq/capybara": patch
---

`ToolCallContext.idempotencyKey`: the key of one logical tool call (64 lowercase hex, derived from
the conversation, the run and the call id), the same across every `InputRequired` round of the
call. A tool with an external side effect passes it downstream (for example as an
`Idempotency-Key` header). The SDK docs now state that a call id is unique only within its run and
that the kernel never retries a call whose result is unknown.
