---
"@capybara-hq/capybara": patch
---

A cloud sandbox provider that refuses a device's tier (for example sandbox-docker or sandbox-e2b with
`openEgress: "off"` at the open tier) now gives the model an actionable tool error
(`sandbox.tier_refused`) instead of a generic failure; any other failed create is
`sandbox.create_failed`. TaskOutput and TaskStop called with a sub-agent's agentId say that its
report arrives as a notification, so the model stops polling for it.

The bootstrap plugins move to the plugins marketplace at 3750cf7: sandbox-docker 0.1.0-rc.12 (sandbox
tiers, `openEgress` defaulting to `proxy`; rc.10 refused the open tier by default), and the other
pins to the versions built on plugin-sdk rc.17. The compose sandbox image contexts follow the commit.
