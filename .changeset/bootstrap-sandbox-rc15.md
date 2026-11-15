---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

The sandbox-docker bootstrap pin moves to rc.15 (capybara-hq/plugins 08074e9): the egress proxy
refuses the Azure WireServer address and the deployment's `deniedCidrs`, and an open-public
instance made before `refuseOpenNetwork` is recreated. The compose sandbox build contexts point at
the same commit.
