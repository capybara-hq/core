---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

A model provider is now on in an organization only when the organization enabled it (its extension
switch on, or a required bootstrap plugin), like every other extension. A provider an organization
never enabled is absent from its model lists and catalog and resolves to `agent.model_unavailable`
("not enabled in this organization").
Org readiness (`GET /orgs/:orgId/readiness`, `agents.readiness`, computed once in
`ReadinessService`) answers `modelProvider: "org_fixable"` with `orgFixableProviders` (each provider
with its reason: `not_enabled`, or `needs_config` when it is on but waits for the org's own config)
when an org admin can make a provider the platform offers usable, and `none` when only the super
admin can help.
