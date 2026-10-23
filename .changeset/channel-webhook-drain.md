---
"@capybara-hq/kernel": patch
---

A channel plugin's `webhook.handle` now counts toward the plugin instance's in-flight calls, so
disabling or upgrading the plugin waits for running webhook requests (`pluginHost.drainSeconds`)
before `dispose`, and aborts them past that (503 `channel.webhook_retry`, the platform retries). A
request that reaches an instance already being revoked answers 503 `plugin.unavailable`.
