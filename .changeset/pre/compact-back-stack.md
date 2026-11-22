---
"@capybara-hq/capybara": patch
"@capybara-hq/design": patch
---

Back on compact no longer traps the person on a section's first page. Without an in-app history
entry behind the page, back went to the last linked path segment, which on `/account/profile`
(and `/settings/organization`) is the page itself: a link to the same address replaces the entry
and changes nothing, so back never left. Back now skips a segment that links to the current page.

Settings sub-nav items and link tabs are sibling views of one page: switching between them now
replaces the history entry instead of pushing one, so back leaves the page rather than retracing
every switch. `LinkComponent` takes an optional `replace`.
