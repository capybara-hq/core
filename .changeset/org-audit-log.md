---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

Org admins can read their organization's audit log: `GET /api/v1/orgs/:orgId/audit` (keyset paged,
optional action prefix, never an event's detail), the `orgs.audit` Platform operation and the
organization settings page 审计日志 / Audit log. The super admin's `GET /api/v1/admin/audit` takes
an optional `orgId` and both routes an optional `action` prefix.
