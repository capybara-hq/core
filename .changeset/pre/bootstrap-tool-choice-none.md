---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

Pin bailian rc.15, deepseek rc.14 and openai-compatible rc.16: a `toolChoice: "none"` request (the
in-context summary and the step-limit wrap-up) no longer drops the tool definitions on DashScope
and DeepSeek, so it reads the conversation's prompt cache instead of rewriting it in full.
