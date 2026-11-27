---
"@capybara-hq/kernel": patch
---

A bound conversation's run-start project read bounds the device's start (60 s) and the read itself
(30 s) apart, so a device whose instance is recreated no longer runs the read out of time and leaves
the conversation without its project's instructions and skills.
