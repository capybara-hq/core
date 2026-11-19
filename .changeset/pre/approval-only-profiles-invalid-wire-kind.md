---
"@capybara-hq/plugin-sdk": patch
"@capybara-hq/device": patch
"@capybara-hq/kernel": patch
---

The device protocol carries a scope validation failure as its own typed kind (`invalid`): the
device answers a scope the contract refuses (such as the environment network without the device
filesystem) with it, and the kernel raises it as a `SandboxScopeValidationError` instead of an
untyped machine error.
