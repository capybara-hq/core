---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

The sandbox-docker bootstrap pin moves to rc.16 (capybara-hq/plugins 85aaf65): a cloud Docker device
answers the `list` and `scan` calls, so its projects can be added and scanned from the device page.
The compose sandbox build contexts point at the same commit.
