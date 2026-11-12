---
"@capybara-hq/plugin-sdk": patch
"@capybara-hq/device": patch
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

A local policy change made on the machine (`capybara-device policy ...` while the service runs, a
flipped localhost proxy guard, a new tier ceiling) reaches the deployment at once: the device
pushes its new summary in a `policy` frame (new in the device protocol), and the kernel stores it
as it stores the hello's, so the device page and the next `device_paths` line show it.
