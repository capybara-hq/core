---
"@capybara-hq/kernel": minor
---

The kernel collects crash and load reports of client code. `POST /api/v1/orgs/:orgId/ui/client/
reports` (guest and up) and `POST /api/v1/admin/ui/client/reports` (super admin) take `{ plugin,
build, contribution, kind, message }` (`kind`: `load`, `render`, `event`, `api` or `budget`;
`message` at most 500 characters) and answer 204; one row per (plugin, build, org, contribution,
kind) is upserted with a count. A report is accepted only for a build the reporter could fetch
(and, in an org, an extension enabled there), else 404 `client.not_found`; 20 reports a minute per
account (429). A daily `@LockedCron` on the worker role deletes reports not seen for 30 days. The
admin extension view gains `client` (the install package's client build: files with sizes and the
API version) and `clientReports` (that build's newest 50).
