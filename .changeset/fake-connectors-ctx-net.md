---
"@capybara-hq/kernel": patch
"@capybara-hq/testing": patch
"@capybara-hq/capybara": patch
---

The core connector fixtures (`fake-connector`, `fake-openapi`) request through `ctx.net.fetch`
with the call's `orgId` and no longer take an `allowInsecureLoopback` deployment config: test
kernels set the kernel's `net.allowInsecureLoopback` instead (`testKernelConfig` and the replica
runner do). The `net.*` config descriptions state that the switch lifts every loopback refusal and
that an org's allowed internal https hosts must be listed in `net.noProxy` when `net.httpsProxy` is
set.
