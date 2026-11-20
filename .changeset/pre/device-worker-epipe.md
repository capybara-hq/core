---
"@capybara-hq/device": patch
---

A send to an operation worker that has just exited no longer crashes the whole device program
(an unhandled EPIPE took every running command down); teardown no longer waits for an exit it
already saw.
