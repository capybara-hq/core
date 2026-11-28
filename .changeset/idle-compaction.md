---
"@capybara-hq/capybara": patch
"@capybara-hq/kernel": patch
---

Idle compaction: a conversation that goes quiet is compacted in the background from the prompt cache
before the cache expires, so the next message neither waits for a compaction nor re-reads the long
context at full price. Three settings (platform and org): `idleEnabled`, `idleMinTokensFloor` and
`idleMinWindowRatio`; a person can opt out with a personal preference. It is on by default
(`idleEnabled`), but it does not fire in the default config: it runs only where a model's cache
lasts at least 30 minutes and its in-context summary is gated, which with the default
`promptCache.longTtl: false` is no model today. Turning on the long cache tier (Sonnet, Qwen4-max)
enables it and costs every cache write the long tier's price (Anthropic about 2× instead of 1.25× of
input). Gating an OpenAI model waits for OpenAI credits.
