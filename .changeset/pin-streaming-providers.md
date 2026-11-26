---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

Pin the model provider bootstrap plugins that stream tool call input (anthropic 0.1.0-rc.11, openai
0.1.0-rc.13, openai-compatible 0.1.0-rc.13, ark 0.1.0-rc.13, deepseek 0.1.0-rc.12, bailian 0.1.0-rc.12:
`tool_call_start` / `tool_call_delta`, plugins#279), todo 0.1.0-rc.14 (pinned card, plugins#280) and the
plugins marketplace commit with the compose sandbox image build context to 8a89f4b.
