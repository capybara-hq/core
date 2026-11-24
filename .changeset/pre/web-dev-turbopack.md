---
"@capybara-hq/web": patch
---

Bundle the development web server with Turbopack again (first visits of a route compile in well
under a second instead of several seconds); `CAPYBARA_WEB_WEBPACK=1` falls back to webpack.
