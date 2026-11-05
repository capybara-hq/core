---
"@capybara-hq/kernel": patch
---

A background launch reservation is failed as `launch_abandoned` after twice the launch call's
pipeline limit (the launch exec, the tool timeout, `sandbox.lockWaitSeconds` and the setup margin,
at least 2 minutes) instead of a fixed 2 minutes, so a slow legitimate launch is never cut off.
