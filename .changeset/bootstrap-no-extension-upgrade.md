---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

The bootstrap step now raises a pinned plugin without an extension (a theme, skills or connector
templates) like one with an extension: when its platform version came from the bootstrap and is
lower than the pin, the pinned version is imported and applied through the platform plugin update
(`upgraded`). A version the super admin moved to (another source or a higher version) is kept, and
the run reports the version actually in place instead of the pin.
