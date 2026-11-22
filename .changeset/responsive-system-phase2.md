---
"@capybara-hq/capybara": patch
"@capybara-hq/kernel": patch
"@capybara-hq/design": patch
---

The org admin pages (settings members, tokens, schedules and audit, extensions, trajectories, evals)
use the responsive compact rows, and join the responsive visual matrix.

The conversation list counts its matches only when asked (`withTotal=true`, first page), so the
compact drawer's 30 s poll no longer pays for the count.
