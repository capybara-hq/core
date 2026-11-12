---
"@capybara-hq/capybara": patch
---

A scheduled task calendar read: `GET /api/v1/orgs/:orgId/schedules/calendar` (and the Platform
operation `schedules.calendar`) returns a range's recorded runs and the planned occurrences the
scheduler will fire, from its own ticker, with dense task-days summarized per day.
