---
"@capybara-hq/capybara": patch
---

The process block's planning row draws the capybara at 14 × 10 (one CSS pixel per art pixel),
no larger than the rail's other marks; it no longer shows while calls of a parallel step are still
queued, waiting or running (a sibling's result or an approval record ended the step too early);
and a running `Platform` row names its operation instead of just "call".
