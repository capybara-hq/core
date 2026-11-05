---
"@capybara-hq/web": patch
---

The web proxy renews an expired session on page requests (one refresh per token per process) and
sends signed-out visitors to sign in, or to the setup wizard on a fresh deployment, before any page
renders.
