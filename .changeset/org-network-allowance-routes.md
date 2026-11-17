---
"@capybara-hq/kernel": minor
"@capybara-hq/web": patch
---

Org network allowance routes: the super admin lists, adds and removes an org's internal endpoints
at `/api/v1/admin/orgs/:orgId/network-allowances` (404 `org.network_allowance_not_found` for an id
the org does not list), org admins read their org's list at `GET /api/v1/orgs/:orgId/network-allowances`;
Platform operations `admin.org-network-allowances`, `admin.org-network-allowance-add`,
`admin.org-network-allowance-remove` and `orgs.network-allowances`. The audit logs label the two
allowance actions.
