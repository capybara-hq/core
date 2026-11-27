---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

Pin the model provider bootstrap plugins with the prompt-cache fixes (plugins#304): bailian
0.1.0-rc.13 (the history is cached, not only the system prompt), ark 0.1.0-rc.14 and
openai-compatible 0.1.0-rc.14 (implicit cache reported per model, a per-conversation
`prompt_cache_key`, qwen dialect cache markers), openai 0.1.0-rc.14 (`prompt_cache_key` per org and
system prompt); device-docker 0.1.0-rc.35 (docs only, listed at the same marketplace commit); and
the plugins marketplace commit with the compose sandbox image build contexts to 87ca221.
