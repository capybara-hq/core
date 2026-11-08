---
"@capybara-hq/web": patch
---

Credentials never travel in a URL: every form posts, and when the client JS does not load the
proxy completes sign-in and setup server side (a GET with credential fields is redirected without
them). `CAPYBARA_WEB_DEV_ORIGINS` lets the dev server serve its scripts to LAN addresses.
