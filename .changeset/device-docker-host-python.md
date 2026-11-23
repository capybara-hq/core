---
"@capybara-hq/device": patch
---

Docker mode checks for the host's /usr/bin/python3 at login and at start, and refuses with what is
missing, why it is needed and how to install it; a refused login stores nothing.
