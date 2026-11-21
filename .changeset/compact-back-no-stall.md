---
"@capybara-hq/design": patch
"@capybara-hq/capybara": patch
---

Compact: the floating back button no longer pauses about half a second before its transition. The
back settles as soon as the shell commits the route it landed on (or on the task after its
`popstate` when no route changed) instead of waiting for a frame the browser does not render while
a view transition's update is pending.
