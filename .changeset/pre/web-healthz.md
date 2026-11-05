---
"@capybara-hq/web": patch
---

The web image's health check asks `/healthz`, which the web server answers itself (no Next, no kernel), instead of `/login`, which now reads the kernel and redirects a fresh deployment to `/setup`. Creating the first agent from the setup layout lands on a new conversation with it again.
