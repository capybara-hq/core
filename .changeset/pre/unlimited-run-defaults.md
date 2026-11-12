---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

Agent runs have no step limit and no duration limit by default: `runtime.maxSteps` and
`runtime.maxRunSeconds` default to 0 (no limit), so a run goes on until the model stops calling
tools or someone stops it. Without a run duration limit, sandbox commands are limited only by
`sandbox.limits.maxCommandSeconds` and the tool timeouts; explicit positive limits work as before.
