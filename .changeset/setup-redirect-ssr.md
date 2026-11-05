---
"@capybara-hq/web": patch
---

A deployment without an admin goes to the setup wizard on the server, before any page is painted
(`/`, workspace pages and `/login` redirect to `/setup`; `/setup` redirects to `/login` once set up).
