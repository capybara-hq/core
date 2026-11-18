---
"@capybara-hq/kernel": patch
"@capybara-hq/device": patch
---

Staged instance binding (fix round 2): a binding compares the environment fingerprint with the
device's latest installed binding, so an environment change across a generation whose answer was
lost still resets Full consent; a binding committed before a re-login follows the active machine
before it is sent. The bundled device runtime carries the Apache-2.0 modification notice of the
patched sandbox runtime and refuses optional or platform-specific packages.
