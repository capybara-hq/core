---
"@capybara-hq/kernel": patch
"@capybara-hq/web": patch
---

Prepare recorded-only full-run replay of the permission context: a recorded feeder for the target run's permission context events (sparse request coordinates, persistent idempotency), the structural removal of any live permission recorder from replay loop dependencies, original-coordinate drift reported as `permission_profile_changed` (with zh and en labels), and verbatim copies of recorded command reviews and managed device paths. The request boundary that invokes the feeder stays dormant until the paired activation.
