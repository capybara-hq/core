---
"@capybara-hq/capybara": patch
"@capybara-hq/web": patch
---

Use Webpack in the development web server to avoid repeated Turbopack HMR reloads.
Make the HTTP login notice conditional on sign-in problems because the browser origin does not
reveal the server's cookie settings.
