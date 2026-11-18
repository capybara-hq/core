---
"@capybara-hq/capybara": patch
"@capybara-hq/kernel": patch
---

The agent form lists GenerateImage while the org's image purpose has a target, and the model purposes pages offer image models for the image purpose and hint when none is mapped.

A new member-readable route, GET /api/v1/orgs/:orgId/model-purposes/available, says whether each purpose has a usable model in the org (the image purpose also needs an object store, exactly as GenerateImage does), so the agent form gates GenerateImage for every member.
