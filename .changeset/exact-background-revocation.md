---
"@capybara-hq/kernel": patch
---

Revoked background tasks are now cancelled by their exact execution reference: the revoke worker
stops the affected task with the five-second grace and acknowledges the revocation only after a
verified stop or exit. A pending cancellation, an unreachable instance or lost supervision keeps it
owed, with backoff. A task that finished lost now retires its running authority and owes that exact
cancellation, and the obligation survives the removal of the task row. A retried start of an
acknowledged operation reuses its recorded starting authority.
