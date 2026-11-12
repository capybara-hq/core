---
"@capybara-hq/capybara": patch
---

A cloud sandbox provider that refuses a device's tier (for example sandbox-docker or sandbox-e2b with
`openEgress: "off"` at the open tier) now gives the model an actionable tool error
(`sandbox.tier_refused`) instead of a generic failure; any other failed create is
`sandbox.create_failed`. TaskOutput and TaskStop called with a sub-agent's agentId say that its
report arrives as a notification, so the model stops polling for it.
