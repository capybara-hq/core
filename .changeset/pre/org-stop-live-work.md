---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

Share one run-liveness helper across run queueing, the execution fence, the orphan check and
deletion, and stop only the live conversations of a deleted organization, recording the
`org_deleted` stop reason.
