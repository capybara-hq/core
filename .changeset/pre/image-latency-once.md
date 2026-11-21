---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

An image generation call measures its latency once: the `model.response` hook payload and the
returned result report the same `latencyMs` (they could differ by a millisecond).
