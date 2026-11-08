---
"@capybara-hq/kernel": minor
---

Org admins and the super admin can hide and reorder extension contributions per UI slot: the org
setting `uiArrangement` and the deployment setting `uiArrangement` (an org's entry replaces the
platform's for that slot). Hidden means not listed: the contribution lists apply it, the view,
action and embed routes do not. `GET /orgs/:orgId/ui/arrangement` and `GET /admin/ui/arrangement`
list the slots with their items for the arrangement page.
