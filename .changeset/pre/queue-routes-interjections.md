---
"@capybara-hq/kernel": patch
---

`POST /api/v1/orgs/:orgId/conversations/:id/queue` is deprecated and now behaves as `POST …/messages`: the message is logged at once (an interjection while a run is active, a new run otherwise) and the route answers `202 { event }` instead of `201 { item }`. Nothing new is queued; items already queued by an earlier version are still sent by the dispatcher after each run and can still be listed, edited, deleted, sent now or resumed. The queue routes and the `conversation_queue` table are removed in a later release.
