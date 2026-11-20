---
"@capybara-hq/kernel": patch
---

The model-facing refusal of an escalation (`sandbox: "escalated"`) names the layer whose
outside-sandbox setting blocks it, never "Full access": the device (its owner runs `capybara-device
ceiling set --outside-sandbox on` on the machine), the organization (an organization admin allows
it), the platform (a super admin allows it), or a cloud instance, which has no outside of its
sandbox. The policy refusals `org.outside_sandbox_not_allowed` and
`deployment.outside_sandbox_not_allowed` get one text each, and an approval that no longer matches
names the outside-sandbox setting.
