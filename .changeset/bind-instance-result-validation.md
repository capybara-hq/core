---
"@capybara-hq/kernel": patch
---

Fix the device relay's staged result check for `bindInstance`: it now validates the answer against
the request it sent, so a bind against a protocol 3 machine no longer always fails.
