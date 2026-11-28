---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

A `compaction` model purpose: a platform or org admin can map a cheaper summary model for
compaction (kind `chat`); an unmapped or unusable mapping falls back to the conversation's model.
With a compaction model, idle compaction gains a transcript mode that does not need a warm cache:
it runs after `idleDelayMinutes` of inactivity (default 30). Cache mode keeps its timing from the
cache and has no delay field.

Data residency: with a compaction model, the conversation transcript is sent to that model's
provider, not the conversation model's. Choose a provider the deployment may send it to.

Measured transcript recall of the compaction model (idle spec quality gate, 20 seeded
conversations): `qwen4-max` 97.1%, `qwen3.8-flash` 90.0%, `deepseek-flash` 87.5%,
`claude-haiku-5-5` 81.3%, `deepseek-v4-pro` 80.4%, `claude-sonnet-5-5` 73.8%. OpenAI `gpt-5-nano`
keeps only 19.6% (8/20 constraints) and is unsuitable as a compaction model.
