---
"@capybara-hq/design": patch
"@capybara-hq/capybara": patch
---

Web: an extension embed (such as the browser panel) no longer flashes white when it opens in the
dark theme. The frame stays hidden until its document has loaded and no longer inherits the dark
color scheme, so the browser keeps the embed's canvas transparent instead of painting it light.
