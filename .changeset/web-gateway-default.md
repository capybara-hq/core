---
"@capybara-hq/web": patch
---

`/device/connect` upgrades go to `CAPYBARA_KERNEL_URL` when `CAPYBARA_WEB_GATEWAY_URL` is unset, so a single kernel process (every role, as in development) needs no extra setting; only deployments with separate gateway replicas set it (compose does).
