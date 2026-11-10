---
"@capybara-hq/kernel": patch
---

Setup guides v2 for connector templates: the guide route renders a template's guide for the org's
connector made from it (`connectorId`, `connectorName`), connectors created from a template record
the guide they were set up with (`connectors.guide_ack`, migration 0106, which also clears the v1
acks of channel connections), connector views carry `setupGuide` and `guideDrift`, and
`POST /api/v1/orgs/:orgId/connectors/:connectorId/guide-ack` confirms an updated app (409
`connector.guide_changed`; a human-only Platform exclusion). Catalog template entries and the
connector template list carry `guide`; the platform update preview lists `guideChanges` with org
counts.
