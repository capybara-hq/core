---
"@capybara-hq/design": patch
"@capybara-hq/web": patch
---

The image zoom says so when the image cannot be loaded, with a retry (a session refresh, then the
attachment URL with its retry token); a new source clears the failure, and the retry disappears once
the one reload has been used.
