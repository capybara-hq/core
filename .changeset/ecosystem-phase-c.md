---
"@capybara-hq/plugin-sdk": patch
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
"@capybara-hq/web": patch
"@capybara-hq/plugin-sandbox-docker": patch
"@capybara-hq/plugin-sandbox-e2b": patch
---

Agents can dispatch sub-agents with the builtin `agent` tool; plugins can ship agent templates;
sandboxes run commands of parallel sub-agents concurrently.

The kernel shares a conversation's sandbox between up to `sandbox.maxConcurrentCommands` holders
(new, hot, default 6) under shared leases, keeps lifecycle changes exclusive, and kills only a
crashed holder's commands by their tag.
