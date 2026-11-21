---
"@capybara-hq/design": patch
"@capybara-hq/capybara": patch
---

Compact: the floating back button no longer slides the page in twice. A pop the back button
animates with a view transition sets no CSS slide on the shell's main region, so the slide does not
run again once the transition ends.
