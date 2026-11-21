---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

Stopping a conversation's run (and an offboarding run stop) no longer misses a run that suspends
for an approval or input at the same moment: after the stop marker is set, a run found `waiting`
is ended directly, so it never stays waiting with the stop lost.
