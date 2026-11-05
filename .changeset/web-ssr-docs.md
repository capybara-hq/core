---
"@capybara-hq/web": patch
---

Signing in, finishing the setup wizard and signing up or accepting through an invitation now load
the next page as a new document (after telling the other tabs), so the new session's frame is
rendered on the server; the submit button stays busy until the page is replaced.
