---
"@capybara-hq/device": patch
---

Stage graceful drain for the protocol-3 session: a draining device refuses new admissions but keeps
serving exact status, output reads, tails, stops, revocation and retries of already admitted
operations. The drain finishes only when in-flight requests and everything the supervisor owns
(acknowledged tasks whose start request already answered, output collectors, pending exact
cancellations and deferred persistence) have settled; a timed-out drain reports what is pending and
the device is not reused. The owner watcher now also stays on while an exact cancellation settles.
Protocol 2 is unchanged.
