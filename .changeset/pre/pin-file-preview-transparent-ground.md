---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

Pin file-preview rc.5: the file previewer paints no ground of its own before the host's `init`, so
it no longer flashes white in the dark theme.
