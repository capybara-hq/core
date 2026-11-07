---
"@capybara-hq/kernel": patch
---

A streaming reply is a live draft kept in Redis (coalesced to 200 ms, 10 minute TTL) and sent on the conversation stream as `event: draft` after the catch-up, so another replica or a reload sees the current text. `GET /api/v1/orgs/:orgId/conversations/:id/runs/:runId/draft` returns the drafts of a run (`[]` on a Redis error). Drafts are never written to the event log and never replayed.
