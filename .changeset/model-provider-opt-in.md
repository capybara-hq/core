---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

A model provider is now on in an organization only when the organization enabled it (its extension
switch on, or a required bootstrap plugin), like every other extension. A provider an organization
never enabled is absent from its model lists and catalog and resolves to `agent.model_unavailable`
("not enabled in this organization").
