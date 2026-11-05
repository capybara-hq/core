---
"@capybara-hq/kernel": patch
---

A person can archive and delete their conversations. `PATCH …/conversations/:id` takes
`{ title?, archived? }` (at least one), `DELETE …/conversations/:id` soft-deletes: it stops an
active run, hides the conversation everywhere for its owner and drops its channel bindings, while
the event log and trajectory stay. Archived conversations leave the default lists and a new message
brings them back; views carry `archivedAt`.
